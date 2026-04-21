// Operations 2.2a, 2.2b, 2.2c — Test Suite generation.
//
// 2.2a: Generate test cases per workflow (batch).
// 2.2b: Entity coverage check (single AI call).
// 2.2c: Format the Test Suite markdown document (single AI call).

import type { OperationExecutor } from "@core/operation-executor";
import { parseYAML, parsePlainText } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import type { OperationDefinition } from "@core/types";

import { executeBatch } from "./batch-utils";

// ── 2.2a — Test Case Generation (batch) ────────────────────────

export async function executeTestCaseGenerationBatch(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  detailedWorkflows: string[],
): Promise<{ testCaseBlocks: string[] }> {
  const contract = await getActiveContract(storage, sessionId);
  const systemPrompt = registry.get(PHASE2_PROMPT_SLUGS.testCaseGeneration);

  const results = await executeBatch(detailedWorkflows, async (wfYaml) => {
    const def: OperationDefinition = {
      operationId: "op-2-2a",
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Product description:\n${contract}\n\nWorkflow to test:\n${wfYaml}`,
        },
      ],
      expectedOutputFormat: "yaml",
      outputParser: parseYAML,
      maxRetries: 1,
      retryPrompt: "Respond with valid YAML test cases.",
      timeoutMs: 120_000,
      role: "reasoning",
    };

    const result = await executor.execute(def, { sessionId });
    if (result.status === "failed" || !result.output) {
      throw new Error(result.error ?? "test case generation failed");
    }
    return result.output.rawText;
  });

  if (results.failed.length > 0) {
    console.warn(
      `op-2-2a: ${results.failed.length} workflow(s) failed test case gen`,
    );
  }

  return {
    testCaseBlocks: results.succeeded.map((s) => s.result as string),
  };
}

// ── 2.2b — Entity Coverage Check ───────────────────────────────

export async function executeEntityCoverageCheck(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  workflowMapStructuredData: string,
): Promise<{ coverageYaml: string }> {
  const contract = await getActiveContract(storage, sessionId);

  const def: OperationDefinition = {
    operationId: "op-2-2b",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.entityCoverageCheck),
    messages: [
      {
        role: "user",
        content: `Project Contract (contains the entity map):\n${contract}\n\nWorkflow Map data:\n${workflowMapStructuredData}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt: "Respond with valid YAML coverage report.",
    timeoutMs: 120_000,
    role: "fast",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-2b failed: ${result.error ?? "unknown"}`);
  }

  return { coverageYaml: result.output.rawText };
}

// ── 2.2c — Test Suite Formatting ───────────────────────────────

export async function executeTestSuiteFormatting(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  testCaseBlocks: string[],
  coverageYaml: string,
  sessionId: string,
): Promise<{ content: string; structuredData: string }> {
  const allTestsYaml = testCaseBlocks.join("\n---\n");
  const combined = `Test cases:\n${allTestsYaml}\n\nEntity coverage:\n${coverageYaml}`;

  const def: OperationDefinition = {
    operationId: "op-2-2c",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.testSuiteFormatting),
    messages: [
      {
        role: "user",
        content: `Format the following test data into a markdown document:\n\n${combined}`,
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
    throw new Error(`op-2-2c failed: ${result.error ?? "unknown"}`);
  }

  return {
    content: result.output.rawText,
    structuredData: allTestsYaml,
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
