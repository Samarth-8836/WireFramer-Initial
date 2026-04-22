import { describe, expect, it } from "vitest";

import type { OperationExecutor } from "@core/operation-executor";
import { PromptRegistry, registerPhase2Prompts } from "@core/prompts";
import { MemoryStorage } from "@core/storage";

import { executeWorkflowDetailBatch } from "../op-2-1-workflow-map";
import { executeTestCaseGenerationBatch } from "../op-2-2-test-suite";

// Regression: batch ops used to return an empty array when every item
// failed, letting downstream ops operate on garbage. They now throw.
// Without this the design stage could "succeed" with no documents —
// see the manual QA failure where `assertDagSucceeded` didn't catch
// the problem because op-2-1b silently produced `[]`.

function makeFailingExecutor(errorMsg = "mocked failure"): OperationExecutor {
  return {
    execute: async () => ({
      operationId: "op-2-1b",
      status: "failed" as const,
      output: null,
      error: errorMsg,
      tokenUsage: { input: 0, output: 0 },
      cost: 0,
      durationMs: 0,
    }),
  } as unknown as OperationExecutor;
}

async function seedStorageWithContract(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  const now = "2026-04-22T00:00:00.000Z";
  await storage.createSession({
    id: "s1",
    title: "Test",
    currentPhaseId: "phase-1",
    createdAt: now,
    updatedAt: now,
    status: "active",
  });
  await storage.createDocument({
    id: "c1",
    sessionId: "s1",
    phaseId: "phase-1",
    type: "project_contract",
    content: "Goal: test",
    structuredData: "",
    version: 1,
    status: "active",
    createdAt: now,
    lastModifiedAt: now,
  });
  return storage;
}

describe("executeWorkflowDetailBatch (op-2-1b)", () => {
  it("throws when every workflow fails to detail", async () => {
    const storage = await seedStorageWithContract();
    const executor = makeFailingExecutor("mocked rate limit");
    const registry = new PromptRegistry();
    registerPhase2Prompts(registry);

    await expect(
      executeWorkflowDetailBatch(executor, registry, storage, "s1", [
        { id: "wf-1" },
        { id: "wf-2" },
      ]),
    ).rejects.toThrow(/failed on all 2 workflow/);
  });

  it("does not throw when the batch is empty (zero-item edge case)", async () => {
    const storage = await seedStorageWithContract();
    const executor = makeFailingExecutor();
    const registry = new PromptRegistry();
    registerPhase2Prompts(registry);

    const r = await executeWorkflowDetailBatch(
      executor,
      registry,
      storage,
      "s1",
      [],
    );
    expect(r.detailedWorkflows).toEqual([]);
  });
});

describe("executeTestCaseGenerationBatch (op-2-2a)", () => {
  it("throws when every workflow fails test case generation", async () => {
    const storage = await seedStorageWithContract();
    const executor = makeFailingExecutor("mocked parse error");
    const registry = new PromptRegistry();
    registerPhase2Prompts(registry);

    await expect(
      executeTestCaseGenerationBatch(executor, registry, storage, "s1", [
        "id: wf-1\nsteps: [...]",
        "id: wf-2\nsteps: [...]",
      ]),
    ).rejects.toThrow(/failed on all 2 workflow/);
  });
});
