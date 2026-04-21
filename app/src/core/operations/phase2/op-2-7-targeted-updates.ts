// Ops 2.7c + 2.7d — Targeted updates during Phase 2 cascades.
//
// 2.7c: Update the screen inventory based on change_context.screen_changes.
// 2.7d: Update a single workflow based on change detail.

import type { OperationExecutor } from "@core/operation-executor";
import { parseYAML } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import type { OperationDefinition } from "@core/types";

// ── 2.7c — Targeted Screen Inventory Update ───────────────────

export async function executeTargetedScreenUpdate(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  currentScreenInventoryYaml: string,
  screenChangesDescription: string,
  workflowContext: string,
  sessionId: string,
): Promise<{ updatedScreenInventoryYaml: string }> {
  const def: OperationDefinition = {
    operationId: "op-2-7c",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.targetedScreenUpdate),
    messages: [
      {
        role: "user",
        content: `Current screen inventory:\n${currentScreenInventoryYaml}\n\nChanges to apply:\n${screenChangesDescription}\n\nWorkflow context:\n${workflowContext}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt:
      "Respond with the COMPLETE updated screen inventory in YAML format.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-7c failed: ${result.error ?? "unknown"}`);
  }

  return { updatedScreenInventoryYaml: result.output.rawText };
}

// ── 2.7d — Targeted Workflow Update ───────────────────────────

export async function executeTargetedWorkflowUpdate(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  currentWorkflowYaml: string,
  changeDetail: string,
): Promise<{ updatedWorkflowYaml: string }> {
  const contract = await getActiveContract(storage, sessionId);

  const def: OperationDefinition = {
    operationId: "op-2-7d",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.targetedWorkflowUpdate),
    messages: [
      {
        role: "user",
        content: `Project Contract:\n${contract}\n\nCurrent workflow:\n${currentWorkflowYaml}\n\nChange to apply:\n${changeDetail}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt:
      "Respond with the COMPLETE updated workflow in YAML format.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-7d failed: ${result.error ?? "unknown"}`);
  }

  return { updatedWorkflowYaml: result.output.rawText };
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
  if (!contract) throw new Error("No active project contract found");
  return contract.content;
}
