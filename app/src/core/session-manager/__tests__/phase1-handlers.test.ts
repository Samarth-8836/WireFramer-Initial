import { describe, expect, it } from "vitest";

import { SSEWriter } from "@core/operation-executor";

import {
  CLARIFYING_QUESTION_OUTPUT,
  makePhase1Harness,
  SAMPLE_CONTRACT_MARKDOWN,
  SAMPLE_GENERATION_CONTEXT,
  VALIDATION_FAIL_OUTPUT,
  VALIDATION_PASS_OUTPUT,
} from "@core/operations/phase1/__tests__/test-helpers";

// Helper — grab all SSE events written via a recording stub so tests can
// assert on the wire output without parsing SSE framing.
interface RecordedEvent {
  type: string;
  data: unknown;
}

function makeRecordingSSE(): { sse: SSEWriter; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const sse = new SSEWriter();
  sse.createStream();
  const original = sse.send.bind(sse);
  sse.send = (event) => {
    events.push({ type: event.type, data: event.data });
    return original(event);
  };
  return { sse, events };
}

async function seedSession(
  harness: ReturnType<typeof makePhase1Harness>,
): Promise<string> {
  const sessionId = "sess-test-1";
  const now = new Date().toISOString();
  await harness.storage.createSession({
    id: sessionId,
    title: "Test",
    currentPhaseId: "phase-1",
    createdAt: now,
    updatedAt: now,
    status: "active",
  });
  await harness.storage.upsertPhaseState({
    sessionId,
    phaseId: "phase-1",
    status: "active",
    enteredAt: now,
    completedAt: null,
    suspendedAt: null,
  });
  return sessionId;
}

describe("Phase1HandlersImpl.handleFirstMessage — happy path", () => {
  it("runs Two-AI, persists user + assistant messages, creates the contract document", async () => {
    const harness = makePhase1Harness([
      // Call A — Op 1.1 conversational (goal expansion)
      { rawText: SAMPLE_GENERATION_CONTEXT },
      // Call B — Op 1.1 project contract generator
      { rawText: SAMPLE_CONTRACT_MARKDOWN },
    ]);
    const sessionId = await seedSession(harness);

    const { sse, events } = makeRecordingSSE();
    await harness.handlers.handleFirstMessage(
      sessionId,
      "I want a simple task tracker",
      sse,
    );

    // 1. Both LLM calls made.
    expect(harness.executor.callCount).toBe(2);

    // 2. User message persisted.
    const messages = await harness.storage.getMessagesByPhase(
      sessionId,
      "phase-1",
    );
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("I want a simple task tracker");
    expect(userMessages[0].metadata.operationId).toBe("op-1-1");

    // 3. Assistant message persisted.
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toContain("sketched out the product");

    // 4. Document created and active.
    const contract = await harness.storage.getActiveDocument(
      sessionId,
      "project_contract",
    );
    expect(contract).not.toBeNull();
    expect(contract!.version).toBe(1);
    expect(contract!.content).toContain("## Goal Statement");
    expect(contract!.content).toContain("## Personas");
    expect(contract!.content).toContain("## Entity Map");
    expect(contract!.content).toContain("## Boundaries");

    // 5. SSE fired a document event.
    const docEvents = events.filter((e) => e.type === "document");
    expect(docEvents).toHaveLength(1);
    expect((docEvents[0].data as { version: number }).version).toBe(1);
  });
});

describe("Phase1HandlersImpl.handleFirstMessage — clarifying question", () => {
  it("persists the assistant message but does NOT create a document when Call A asks a question", async () => {
    const harness = makePhase1Harness([
      { rawText: CLARIFYING_QUESTION_OUTPUT },
      // No Call B response needed — pattern short-circuits.
    ]);
    const sessionId = await seedSession(harness);

    const { sse, events } = makeRecordingSSE();
    await harness.handlers.handleFirstMessage(sessionId, "payments", sse);

    expect(harness.executor.callCount).toBe(1);

    const contract = await harness.storage.getActiveDocument(
      sessionId,
      "project_contract",
    );
    expect(contract).toBeNull();

    const assistant = (
      await harness.storage.getMessagesByPhase(sessionId, "phase-1")
    ).find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toContain("personal use or a team");

    // No document event fired because no document was generated.
    const docEvents = events.filter((e) => e.type === "document");
    expect(docEvents).toHaveLength(0);
  });
});

describe("Phase1HandlersImpl.handleIteration — version bump", () => {
  it("creates version 2 of the Project Contract when iterating", async () => {
    const harness = makePhase1Harness([
      // First message — two calls
      { rawText: SAMPLE_GENERATION_CONTEXT },
      { rawText: SAMPLE_CONTRACT_MARKDOWN },
      // Iteration — two more calls
      { rawText: SAMPLE_GENERATION_CONTEXT },
      { rawText: SAMPLE_CONTRACT_MARKDOWN.replace("task tracker", "task tracker with tags") },
    ]);
    const sessionId = await seedSession(harness);

    const sse1 = new SSEWriter();
    sse1.createStream();
    await harness.handlers.handleFirstMessage(sessionId, "task tracker", sse1);

    const sse2 = new SSEWriter();
    sse2.createStream();
    await harness.handlers.handleIteration(sessionId, "add tags", sse2);

    // Active doc should now be version 2.
    const active = await harness.storage.getActiveDocument(
      sessionId,
      "project_contract",
    );
    expect(active!.version).toBe(2);
    expect(active!.content).toContain("tags");

    // Historical v1 still retrievable and inactive.
    const all = await harness.storage.getDocumentsBySession(sessionId);
    const contracts = all.filter((d) => d.type === "project_contract");
    expect(contracts).toHaveLength(2);
    const v1 = contracts.find((d) => d.version === 1);
    expect(v1!.status).toBe("inactive");
  });
});

describe("Phase1HandlersImpl.completePhase — validation outcomes", () => {
  it("transitions phase-1 to complete on PASS", async () => {
    const harness = makePhase1Harness([
      // Seed: first message
      { rawText: SAMPLE_GENERATION_CONTEXT },
      { rawText: SAMPLE_CONTRACT_MARKDOWN },
      // Completion: validation
      { rawText: VALIDATION_PASS_OUTPUT },
    ]);
    const sessionId = await seedSession(harness);
    await harness.handlers.handleFirstMessage(
      sessionId,
      "build a tracker",
      makeRecordingSSE().sse,
    );

    const { sse, events } = makeRecordingSSE();
    await harness.handlers.completePhase(sessionId, sse);

    const phase = await harness.storage.getPhaseState(sessionId, "phase-1");
    expect(phase!.status).toBe("complete");
    expect(phase!.completedAt).not.toBeNull();

    const testResults = events.find((e) => e.type === "test_results");
    expect(testResults).toBeDefined();
    expect((testResults!.data as { status: string }).status).toBe("PASS");

    // validation_result message persisted.
    const messages = await harness.storage.getMessagesByPhase(
      sessionId,
      "phase-1",
    );
    const validation = messages.find((m) => m.type === "validation_result");
    expect(validation).toBeDefined();
    expect(validation!.content).toContain("STATUS: PASS");
  });

  it("keeps phase-1 active on FAIL and surfaces issues in the validation_result message", async () => {
    const harness = makePhase1Harness([
      { rawText: SAMPLE_GENERATION_CONTEXT },
      { rawText: SAMPLE_CONTRACT_MARKDOWN },
      { rawText: VALIDATION_FAIL_OUTPUT },
    ]);
    const sessionId = await seedSession(harness);
    await harness.handlers.handleFirstMessage(
      sessionId,
      "tracker",
      makeRecordingSSE().sse,
    );

    const { sse } = makeRecordingSSE();
    await harness.handlers.completePhase(sessionId, sse);

    const phase = await harness.storage.getPhaseState(sessionId, "phase-1");
    expect(phase!.status).toBe("active");
    expect(phase!.completedAt).toBeNull();

    const messages = await harness.storage.getMessagesByPhase(
      sessionId,
      "phase-1",
    );
    const validation = messages.find((m) => m.type === "validation_result");
    expect(validation).toBeDefined();
    expect(validation!.content).toContain("STATUS: FAIL");
    expect(validation!.content).toContain("Boundaries section is empty");
  });
});
