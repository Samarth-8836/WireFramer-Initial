import { OperationExecutor } from "@core/operation-executor";
import { PromptRegistry } from "@core/prompts";
import { MemoryStorage } from "@core/storage";
import type {
  ChatMessage,
  Document,
  MessageRole,
  MessageType,
  OperationDefinition,
  OperationResult,
  PhaseId,
} from "@core/types";

import { ContextBuilder } from "../context-builder";
import { Summarizer } from "../summarizer";

// Deterministic executor for Context Builder tests. Overrides the public
// `execute` (not the protected streamCall) because the Summarizer consumes
// execute() directly — we want to intercept there rather than have a fake
// round-trip through the real OperationExecutor pipeline.
export class FakeExecutor extends OperationExecutor {
  public callCount = 0;
  public lastDefinition: OperationDefinition<unknown> | null = null;
  public readonly summary: string;

  constructor(summary: string = "FAKE_SUMMARY") {
    super();
    this.summary = summary;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute<T>(
    definition: OperationDefinition<T>,
  ): Promise<OperationResult<T>> {
    this.callCount += 1;
    this.lastDefinition = definition as OperationDefinition<unknown>;

    const parsed = definition.outputParser(this.summary);
    if (!parsed.success) {
      return {
        operationId: definition.operationId,
        status: "failed",
        output: null,
        error: parsed.error,
        tokenUsage: { input: 0, output: 0 },
        cost: 0,
        durationMs: 1,
      };
    }

    return {
      operationId: definition.operationId,
      status: "success",
      output: parsed,
      error: null,
      tokenUsage: { input: 10, output: 5 },
      cost: 0,
      durationMs: 1,
    };
  }
}

// Executor that fails every call — used to drive summarizer fallback.
export class FailingExecutor extends OperationExecutor {
  public callCount = 0;
  async execute<T>(
    definition: OperationDefinition<T>,
  ): Promise<OperationResult<T>> {
    this.callCount += 1;
    return {
      operationId: definition.operationId,
      status: "failed",
      output: null,
      error: "synthetic failure",
      tokenUsage: { input: 0, output: 0 },
      cost: 0,
      durationMs: 1,
    };
  }
}

export function makeChat(
  idx: number,
  sessionId: string,
  phaseId: PhaseId,
  role: MessageRole,
  content: string,
  type: MessageType = "chat",
): ChatMessage {
  return {
    id: `msg-${idx}`,
    sessionId,
    phaseId,
    role,
    type,
    content,
    metadata: {
      screenReference: null,
      generationContext: null,
      operationId: null,
      stale: false,
    },
    createdAt: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
  };
}

export async function seedContract(
  storage: MemoryStorage,
  sessionId: string,
  content: string,
  structuredData: string = "",
): Promise<Document> {
  return storage.createDocument({
    id: `doc-${sessionId}-contract`,
    sessionId,
    phaseId: "phase-1",
    type: "project_contract",
    content,
    structuredData,
    version: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
  });
}

export async function seedWorkflowMap(
  storage: MemoryStorage,
  sessionId: string,
  structuredData: string,
  content: string = "Workflow map content",
): Promise<Document> {
  return storage.createDocument({
    id: `doc-${sessionId}-wfmap`,
    sessionId,
    phaseId: "phase-2",
    type: "workflow_map",
    content,
    structuredData,
    version: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
  });
}

export async function seedScreenInventory(
  storage: MemoryStorage,
  sessionId: string,
  structuredData: string,
  content: string = "Screen inventory content",
): Promise<Document> {
  return storage.createDocument({
    id: `doc-${sessionId}-screens`,
    sessionId,
    phaseId: "phase-2",
    type: "screen_inventory",
    content,
    structuredData,
    version: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
  });
}

export interface ContextBuilderHarness {
  builder: ContextBuilder;
  storage: MemoryStorage;
  registry: PromptRegistry;
  executor: FakeExecutor;
  summarizer: Summarizer;
}

// One-stop shop for tests: fully wired stack with fake prompts registered.
// Tests override registered slugs as needed after construction.
export function makeHarness(
  summary: string = "FAKE_SUMMARY",
): ContextBuilderHarness {
  const storage = new MemoryStorage();
  const registry = new PromptRegistry();
  const slugs = [
    ["phase1-conversational", "SYS_PHASE1_CONV"],
    ["project-contract-generator", "SYS_CONTRACT_GEN"],
    ["phase1-validation", "SYS_PHASE1_VALIDATION"],
    ["workflow-discovery", "SYS_WORKFLOW_DISCOVERY"],
    ["workflow-detail", "SYS_WORKFLOW_DETAIL"],
    ["test-case-generation", "SYS_TEST_CASE_GEN"],
    ["screen-extraction", "SYS_SCREEN_EXTRACT"],
    ["screen-html-generation", "SYS_SCREEN_HTML"],
    ["phase2-conversational", "SYS_PHASE2_CONV"],
    ["drift-check", "SYS_DRIFT"],
  ] as const;
  for (const [slug, body] of slugs) {
    registry.register(slug, body);
  }

  const executor = new FakeExecutor(summary);
  const summarizer = new Summarizer(executor);
  const builder = new ContextBuilder(storage, registry, summarizer);
  return { builder, storage, registry, executor, summarizer };
}
