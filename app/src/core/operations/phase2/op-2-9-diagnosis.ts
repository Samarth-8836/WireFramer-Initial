// Op 2.9 — Test Failure Diagnosis.
//
// Given a failed test, diagnoses the root cause as one of:
//   WIREFRAME_BUG | TEST_BUG | WORKFLOW_FLAW
// Uses the existing parseDiagnosisResult parser.

import type { ContextBuilder } from "@core/context-builder";
import type { OperationExecutor } from "@core/operation-executor";
import { parseDiagnosisResult } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import type { OperationDefinition, IndividualTestResult } from "@core/types";

export interface DiagnosisInput {
  testResult: IndividualTestResult;
  testDefinitionYaml: string;
  workflowYaml: string;
}

export interface DiagnosisOutput {
  diagnosis: string;
  rootCause: string;
  affectedArtifact: string;
  proposedFix: string;
  confidence: string;
}

export async function executeDiagnosis(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  wireframeManager: WireframeManager,
  sessionId: string,
  input: DiagnosisInput,
): Promise<DiagnosisOutput> {
  // Load the screen HTML where the failure occurred.
  let screenHtml = "";
  if (input.testResult.failedStep !== null) {
    // Try to load the screen. The test definition would tell us which
    // screen, but we approximate by using the test's workflow.
    try {
      const files = await wireframeManager.listFiles(sessionId);
      // Use the first HTML file as fallback.
      const htmlFile = files.find((f) => f.endsWith(".html") && f !== "index.html" && f !== "test-harness.html");
      if (htmlFile) {
        screenHtml = await wireframeManager.readFile(sessionId, htmlFile);
      }
    } catch {
      screenHtml = "(screen HTML not available)";
    }
  }

  const userContent = `Test case (human-readable):
${input.testDefinitionYaml}

Executable test steps:
${input.testDefinitionYaml}

Failure details:
- Failed step: ${input.testResult.failedStep ?? "unknown"}
- Step description: ${input.testResult.failedStepDescription ?? "unknown"}
- Error message: ${input.testResult.errorMessage ?? "unknown"}

Screen HTML where failure occurred:
${screenHtml}

Workflow this test is based on:
${input.workflowYaml}`;

  const def: OperationDefinition = {
    operationId: "op-2-9",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.diagnosis),
    messages: [{ role: "user", content: userContent }],
    expectedOutputFormat: "structured",
    outputParser: parseDiagnosisResult,
    maxRetries: 1,
    retryPrompt:
      "Respond in format: diagnosis: [type]\\nroot_cause: [...]\\naffected_artifact: [...]\\nproposed_fix: [...]\\nconfidence: [high/medium/low]",
    timeoutMs: 60_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-9 failed: ${result.error ?? "unknown"}`);
  }

  const data = result.output.data as Record<string, string>;
  return {
    diagnosis: data.diagnosis ?? "TEST_BUG",
    rootCause: data.rootCause ?? data.root_cause ?? "",
    affectedArtifact: data.affectedArtifact ?? data.affected_artifact ?? "",
    proposedFix: data.proposedFix ?? data.proposed_fix ?? "",
    confidence: data.confidence ?? "medium",
  };
}
