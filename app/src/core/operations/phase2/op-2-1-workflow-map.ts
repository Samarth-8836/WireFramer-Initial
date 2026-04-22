// Operations 2.1a, 2.1b, 2.1c — Workflow Map generation.
//
// 2.1a: Discover workflows from the Project Contract (single AI call).
// 2.1b: Detail each workflow (batch — one AI call per workflow).
// 2.1c: Format the Workflow Map markdown document (single AI call).

import type { OperationExecutor } from "@core/operation-executor";
import { parseYAML, parsePlainText } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import type { OperationDefinition } from "@core/types";

import { executeBatch } from "./batch-utils";

// ── 2.1a — Workflow Discovery ──────────────────────────────────

export async function executeWorkflowDiscovery(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
): Promise<{ workflows: unknown[] }> {
  const contract = await getActiveContract(storage, sessionId);

  const def: OperationDefinition = {
    operationId: "op-2-1a",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.workflowDiscovery),
    messages: [{ role: "user", content: contract }],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt: "Your response was not valid YAML. Respond ONLY with the YAML workflows list.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-1a failed: ${result.error ?? "unknown"}`);
  }

  const data = result.output.data as Record<string, unknown>;
  const workflows = (data.workflows ?? []) as unknown[];
  return { workflows };
}

// ── 2.1b — Workflow Detail Generation (batch) ──────────────────

export async function executeWorkflowDetailBatch(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  workflowStubs: unknown[],
): Promise<{ detailedWorkflows: string[] }> {
  const contract = await getActiveContract(storage, sessionId);
  const systemPrompt = registry.get(PHASE2_PROMPT_SLUGS.workflowDetail);

  const results = await executeBatch(workflowStubs, async (stub) => {
    const stubYaml =
      typeof stub === "string" ? stub : JSON.stringify(stub, null, 2);

    const def: OperationDefinition = {
      operationId: "op-2-1b",
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Product description:\n${contract}\n\nWorkflow to detail:\n${stubYaml}`,
        },
      ],
      expectedOutputFormat: "yaml",
      outputParser: parseYAML,
      maxRetries: 1,
      retryPrompt:
        "Your response was not valid YAML. Respond with the complete workflow YAML definition.",
      timeoutMs: 120_000,
      role: "reasoning",
    };

    const result = await executor.execute(def, { sessionId });
    if (result.status === "failed" || !result.output) {
      throw new Error(result.error ?? "workflow detail generation failed");
    }
    return result.output.rawText;
  });

  if (results.failed.length > 0) {
    console.warn(
      `op-2-1b: ${results.failed.length} workflow(s) failed to detail`,
    );
  }

  // If every item failed we have no data to pass downstream. Continuing
  // would give op-2-1c an empty string, which either produces an empty
  // document or fails in an obscure way. Fail loudly so the stage
  // runner marks the whole stage failed instead of silently moving on.
  if (results.succeeded.length === 0 && results.failed.length > 0) {
    const firstError = results.failed[0]?.error ?? "unknown error";
    throw new Error(
      `op-2-1b failed on all ${results.failed.length} workflow(s). First error: ${firstError}`,
    );
  }

  const detailedWorkflows = results.succeeded.map(
    (s) => s.result as string,
  );
  return { detailedWorkflows };
}

// ── 2.1c — Workflow Map Formatting ─────────────────────────────

export async function executeWorkflowMapFormatting(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  detailedWorkflows: string[],
  sessionId: string,
): Promise<{ content: string; structuredData: string }> {
  const allWorkflowsYaml = detailedWorkflows.join("\n---\n");

  const def: OperationDefinition = {
    operationId: "op-2-1c",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.workflowMapFormatting),
    messages: [
      {
        role: "user",
        content: `Format the following workflow data into a markdown document:\n\n${allWorkflowsYaml}`,
      },
    ],
    expectedOutputFormat: "markdown",
    outputParser: parsePlainText,
    maxRetries: 1,
    retryPrompt: "Respond with a markdown document with ## sections.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-1c failed: ${result.error ?? "unknown"}`);
  }

  return {
    content: result.output.rawText,
    structuredData: allWorkflowsYaml,
  };
}

// ── helpers ────────────────────────────────────────────────────

async function getActiveContract(
  storage: IStorage,
  sessionId: string,
): Promise<string> {
  const docs = await storage.getDocumentsBySession(sessionId);
  const contract = docs.find(
    (d) => d.type === "project_contract" && d.status === "active",
  );
  if (!contract) {
    throw new Error("No active project contract found");
  }
  return contract.content;
}
