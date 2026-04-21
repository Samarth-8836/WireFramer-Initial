// Operations 2.3a, 2.3b, 2.3c, 2.3d — Screen Inventory generation.
//
// 2.3a: Extract screens from workflows (single AI call).
// 2.3b: Validate navigation (single AI call).
// 2.3c: Correct screen inventory (conditional, single AI call).
// 2.3d: Format the Screen Inventory document (single AI call).

import type { OperationExecutor } from "@core/operation-executor";
import { parseYAML, parsePlainText } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import type { OperationDefinition } from "@core/types";

// ── 2.3a — Screen Extraction ──────────────────────────────────

export async function executeScreenExtraction(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  workflowMapStructuredData: string,
): Promise<{ screenInventoryYaml: string }> {
  const contract = await getActiveContract(storage, sessionId);

  const def: OperationDefinition = {
    operationId: "op-2-3a",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.screenExtraction),
    messages: [
      {
        role: "user",
        content: `Project Contract:\n${contract}\n\nWorkflow data:\n${workflowMapStructuredData}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt:
      "Respond with valid YAML screen inventory. Each screen needs id, name, type, entry_point.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-3a failed: ${result.error ?? "unknown"}`);
  }

  return { screenInventoryYaml: result.output.rawText };
}

// ── 2.3b — Navigation Validation ──────────────────────────────

export interface NavValidationResult {
  status: "pass" | "has_issues";
  validationYaml: string;
  fixesYaml: string;
}

export async function executeNavValidation(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  screenInventoryYaml: string,
  workflowMapStructuredData: string,
  sessionId: string,
): Promise<NavValidationResult> {
  const def: OperationDefinition = {
    operationId: "op-2-3b",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.screenNavValidation),
    messages: [
      {
        role: "user",
        content: `Screen inventory:\n${screenInventoryYaml}\n\nWorkflow data:\n${workflowMapStructuredData}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt: "Respond with valid YAML validation report.",
    timeoutMs: 120_000,
    role: "fast",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-3b failed: ${result.error ?? "unknown"}`);
  }

  const data = result.output.data as Record<string, unknown>;
  const validation = data.validation as Record<string, unknown> | undefined;
  const status =
    validation?.status === "pass" ? "pass" : ("has_issues" as const);

  return {
    status,
    validationYaml: result.output.rawText,
    fixesYaml: result.output.rawText,
  };
}

// ── 2.3c — Screen Correction (conditional) ────────────────────

export async function executeScreenCorrection(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  originalScreenInventoryYaml: string,
  fixesYaml: string,
  sessionId: string,
): Promise<{ correctedScreenInventoryYaml: string }> {
  const def: OperationDefinition = {
    operationId: "op-2-3c",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.screenCorrection),
    messages: [
      {
        role: "user",
        content: `Original screen inventory:\n${originalScreenInventoryYaml}\n\nFixes to apply:\n${fixesYaml}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt:
      "Respond with the corrected screen inventory in YAML format.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-3c failed: ${result.error ?? "unknown"}`);
  }

  return { correctedScreenInventoryYaml: result.output.rawText };
}

// ── 2.3d — Screen Inventory Formatting ────────────────────────

export async function executeScreenInventoryFormatting(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  finalScreenInventoryYaml: string,
  sessionId: string,
): Promise<{ content: string; structuredData: string }> {
  const def: OperationDefinition = {
    operationId: "op-2-3d",
    systemPrompt: registry.get(
      PHASE2_PROMPT_SLUGS.screenInventoryFormatting,
    ),
    messages: [
      {
        role: "user",
        content: `Format the following screen inventory into a markdown document:\n\n${finalScreenInventoryYaml}`,
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
    throw new Error(`op-2-3d failed: ${result.error ?? "unknown"}`);
  }

  return {
    content: result.output.rawText,
    structuredData: finalScreenInventoryYaml,
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
  if (!contract) throw new Error("No active project contract found");
  return contract.content;
}
