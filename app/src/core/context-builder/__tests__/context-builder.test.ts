import { describe, expect, it } from "vitest";

import { makeChat, makeHarness, seedContract, seedScreenInventory, seedWorkflowMap } from "./test-helpers";

describe("ContextBuilder — Phase 1", () => {
  it("buildPhase1FirstMessage returns registered system prompt + single user message", async () => {
    const { builder } = makeHarness();

    const ctx = await builder.buildPhase1FirstMessage("I want a task tracker");

    expect(ctx.systemPrompt).toBe("SYS_PHASE1_CONV");
    expect(ctx.messages).toEqual([
      { role: "user", content: "I want a task tracker" },
    ]);
  });

  it("buildPhase1Iteration returns filtered chat history + user message", async () => {
    const { builder, storage, executor } = makeHarness();

    await storage.addMessage(
      makeChat(1, "s1", "phase-1", "user", "hi"),
    );
    await storage.addMessage(
      makeChat(2, "s1", "phase-1", "assistant", "hello"),
    );

    const ctx = await builder.buildPhase1Iteration("s1", "tell me more");

    expect(ctx.systemPrompt).toBe("SYS_PHASE1_CONV");
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(ctx.messages[1]).toEqual({ role: "assistant", content: "hello" });
    expect(ctx.messages[2]).toEqual({ role: "user", content: "tell me more" });
    // History small — no summarization call.
    expect(executor.callCount).toBe(0);
  });

  it("buildPhase1Iteration excludes non-chat message types", async () => {
    const { builder, storage } = makeHarness();

    await storage.addMessage(makeChat(1, "s1", "phase-1", "user", "hi"));
    await storage.addMessage(
      makeChat(2, "s1", "phase-1", "assistant", "hello"),
    );
    await storage.addMessage(
      makeChat(3, "s1", "phase-1", "system", "SYSTEM_NOTE", "system_notification"),
    );
    await storage.addMessage(
      makeChat(4, "s1", "phase-1", "system", "DRIFT_NOTE", "drift_warning"),
    );

    const ctx = await builder.buildPhase1Iteration("s1", "next");

    expect(ctx.messages).toHaveLength(3);
    const contents = ctx.messages.map((m) => m.content);
    expect(contents).toContain("hi");
    expect(contents).toContain("hello");
    expect(contents).toContain("next");
    expect(contents).not.toContain("SYSTEM_NOTE");
    expect(contents).not.toContain("DRIFT_NOTE");
  });

  it("buildProjectContractGeneratorContext uses isolated context with NO chat history", async () => {
    const { builder, storage } = makeHarness();

    // Even with history present, the doc generator should ignore it.
    await storage.addMessage(
      makeChat(1, "s1", "phase-1", "user", "HISTORICAL_MSG"),
    );

    const ctx = await builder.buildProjectContractGeneratorContext(
      "GEN_CTX_FROM_CALL_A",
    );

    expect(ctx.systemPrompt).toBe("SYS_CONTRACT_GEN");
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[0].content).toContain("GEN_CTX_FROM_CALL_A");
    expect(ctx.messages[0].content).not.toContain("HISTORICAL_MSG");
  });

  it("buildPhase1Validation returns contract content when contract exists", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildPhase1Validation("s1");

    expect(ctx.systemPrompt).toBe("SYS_PHASE1_VALIDATION");
    expect(ctx.messages).toEqual([
      { role: "user", content: "CONTRACT_BODY" },
    ]);
  });

  it("buildPhase1Validation throws when no active contract exists", async () => {
    const { builder } = makeHarness();

    await expect(builder.buildPhase1Validation("s-missing")).rejects.toThrow(
      /active project contract/,
    );
  });
});

describe("ContextBuilder — Phase 2 auto-generation", () => {
  it("buildWorkflowDiscovery uses the contract as the user message", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildWorkflowDiscovery("s1");

    expect(ctx.systemPrompt).toBe("SYS_WORKFLOW_DISCOVERY");
    expect(ctx.messages[0].content).toBe("CONTRACT_BODY");
  });

  it("buildWorkflowDetail embeds both the contract and the workflow stub", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildWorkflowDetail("s1", "WF_STUB_FOR_wf-001");

    expect(ctx.systemPrompt).toBe("SYS_WORKFLOW_DETAIL");
    expect(ctx.messages[0].content).toContain("CONTRACT_BODY");
    expect(ctx.messages[0].content).toContain("WF_STUB_FOR_wf-001");
  });

  it("buildTestCaseGeneration embeds both the contract and the workflow content", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildTestCaseGeneration("s1", "WORKFLOW_DETAIL");

    expect(ctx.systemPrompt).toBe("SYS_TEST_CASE_GEN");
    expect(ctx.messages[0].content).toContain("CONTRACT_BODY");
    expect(ctx.messages[0].content).toContain("WORKFLOW_DETAIL");
  });

  it("buildScreenExtraction embeds both the contract and the workflow map content", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildScreenExtraction("s1", "WF_MAP_CONTENT");

    expect(ctx.systemPrompt).toBe("SYS_SCREEN_EXTRACT");
    expect(ctx.messages[0].content).toContain("CONTRACT_BODY");
    expect(ctx.messages[0].content).toContain("WF_MAP_CONTENT");
  });

  it("buildScreenHTMLGeneration embeds both the contract and the screen spec", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildScreenHTMLGeneration("s1", "SCREEN_SPEC");

    expect(ctx.systemPrompt).toBe("SYS_SCREEN_HTML");
    expect(ctx.messages[0].content).toContain("CONTRACT_BODY");
    expect(ctx.messages[0].content).toContain("SCREEN_SPEC");
  });

  it("throws when required contract is missing (via buildWorkflowDiscovery)", async () => {
    const { builder } = makeHarness();
    await expect(builder.buildWorkflowDiscovery("s-missing")).rejects.toThrow(
      /Workflow discovery requires an active project contract/,
    );
  });
});

describe("ContextBuilder — Phase 2 conversational", () => {
  const SCREEN_YAML = `
screens:
  - id: screen-001
    name: Signup form
    type: form
    actions:
      - Submit
`;
  const WORKFLOW_YAML = `
workflows:
  - id: wf-001
    name: Signup
    persona: new
    category: onboarding
    steps:
      - screen: screen-001
        action: Submit
    edgeCases: []
`;

  it("with screenRef prefixes the user message with [Viewing: ...] and includes a system context block", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");
    await seedWorkflowMap(storage, "s1", WORKFLOW_YAML);
    await seedScreenInventory(storage, "s1", SCREEN_YAML);

    const ctx = await builder.buildPhase2ConversationalContext(
      "s1",
      "Tighten the submit button copy",
      "screen-001",
    );

    expect(ctx.systemPrompt).toBe("SYS_PHASE2_CONV");
    // Message list shape: [system context, ...history, user]
    const first = ctx.messages[0];
    expect(first.role).toBe("system");
    expect(first.content).toContain("## Project Contract");
    expect(first.content).toContain("CONTRACT_BODY");
    expect(first.content).toContain("## Currently Viewed Screen (Full Detail)");
    expect(first.content).toContain("ID: screen-001");

    const last = ctx.messages[ctx.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(
      "[Viewing: screen-001]\n\nTighten the submit button copy",
    );
  });

  it("without screenRef uses the raw user message and omits screen detail sections", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");
    await seedWorkflowMap(storage, "s1", WORKFLOW_YAML);
    await seedScreenInventory(storage, "s1", SCREEN_YAML);

    const ctx = await builder.buildPhase2ConversationalContext(
      "s1",
      "What would it take to add teams?",
      null,
    );

    const first = ctx.messages[0];
    expect(first.role).toBe("system");
    expect(first.content).not.toContain("## Currently Viewed Screen");
    expect(first.content).not.toContain("## Workflows Touching This Screen");

    const last = ctx.messages[ctx.messages.length - 1];
    expect(last.content).toBe("What would it take to add teams?");
    expect(last.content).not.toContain("[Viewing:");
  });

  it("prepends existing phase-2 chat history between system context and user message", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");
    await storage.addMessage(
      makeChat(1, "s1", "phase-2", "user", "earlier question"),
    );
    await storage.addMessage(
      makeChat(2, "s1", "phase-2", "assistant", "earlier answer"),
    );

    const ctx = await builder.buildPhase2ConversationalContext(
      "s1",
      "follow-up",
      null,
    );

    expect(ctx.messages).toHaveLength(4); // system + 2 history + new user
    expect(ctx.messages[0].role).toBe("system");
    expect(ctx.messages[1]).toEqual({ role: "user", content: "earlier question" });
    expect(ctx.messages[2]).toEqual({ role: "assistant", content: "earlier answer" });
    expect(ctx.messages[3]).toEqual({ role: "user", content: "follow-up" });
  });
});

describe("ContextBuilder — drift check + summary maintenance", () => {
  it("buildDriftCheck embeds the contract and the proposed change context", async () => {
    const { builder, storage } = makeHarness();
    await seedContract(storage, "s1", "CONTRACT_BODY");

    const ctx = await builder.buildDriftCheck("s1", "CHANGE_CTX_BODY");

    expect(ctx.systemPrompt).toBe("SYS_DRIFT");
    expect(ctx.messages[0].content).toContain("CONTRACT_BODY");
    expect(ctx.messages[0].content).toContain("CHANGE_CTX_BODY");
  });

  it("updateConversationSummary delegates to the summarizer and persists", async () => {
    const { builder, storage } = makeHarness();

    await builder.updateConversationSummary(
      "s1",
      "phase-2",
      1,
      "Added onboarding tooltips",
      "screen-level",
      ["screen-001"],
    );

    const saved = await storage.getConversationSummary("s1", "phase-2");
    expect(saved).not.toBeNull();
    expect(saved!.summary).toContain("Iteration 1: Added onboarding tooltips");
    expect(saved!.messagesCovered).toBe(1);
  });
});
