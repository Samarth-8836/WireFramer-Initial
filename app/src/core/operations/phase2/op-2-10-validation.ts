// Op 2.10 — Phase 2 Validation.
//
// Two-step validation before Phase 2 can be marked complete:
//   Step 1: Code-level checks (test run exists, not stale, all pass/known,
//           HTML file for every screen, test defs for every workflow)
//   Step 2: AI validation — cross-references all artifacts for consistency.

import { parse as parseYaml } from "yaml";

import type { OperationExecutor } from "@core/operation-executor";
import {
  parseValidationResult,
  type ValidationResultData,
} from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import type { OperationDefinition, TestRunResult } from "@core/types";

export interface Phase2ValidationResult {
  codeChecks: CodeCheckResult;
  aiValidation: ValidationResultData | null;
  overall: "PASS" | "FAIL";
}

export interface CodeCheckResult {
  passed: boolean;
  failures: string[];
}

// Step 1 — Code-level checks. No AI calls.
export async function runCodeChecks(
  storage: IStorage,
  wireframeManager: WireframeManager,
  sessionId: string,
): Promise<CodeCheckResult> {
  const failures: string[] = [];

  // 1. Test run exists.
  const testRun = await storage.getLatestTestRunResult(sessionId);
  if (!testRun) {
    failures.push(
      "Please run the test suite at least once before completing this phase.",
    );
  }

  // 2. Test run is recent (not stale).
  if (testRun) {
    const artifacts = await storage.getArtifactsBySession(sessionId);
    const latestArtifactModified = artifacts.reduce(
      (max, a) => (a.lastModifiedAt > max ? a.lastModifiedAt : max),
      "",
    );
    if (latestArtifactModified && testRun.runAt < latestArtifactModified) {
      failures.push(
        "The wireframe has changed since tests were last run. Please run tests again.",
      );
    }
  }

  // 3. All tests pass or known issues.
  if (testRun) {
    const failing = testRun.results.filter((r) => r.status === "fail");
    if (failing.length > 0) {
      failures.push(`${failing.length} test(s) are still failing.`);
    }
  }

  // 4. HTML file for every screen in the screen inventory.
  const screenInventoryDoc = await storage.getActiveDocument(
    sessionId,
    "screen_inventory",
  );
  if (screenInventoryDoc) {
    const screenIds = extractScreenIds(screenInventoryDoc.structuredData);
    const wireframeFiles = await wireframeManager.listFiles(sessionId);
    const htmlFiles = new Set(wireframeFiles.filter((f) => f.endsWith(".html")));

    for (const screenId of screenIds) {
      if (!htmlFiles.has(`${screenId}.html`)) {
        failures.push(`Missing wireframe file for screen: ${screenId}`);
      }
    }

    if (screenIds.length === 0 && wireframeFiles.length === 0) {
      failures.push("Missing wireframe files detected.");
    }
  }

  // 5. Test definitions for every workflow.
  const workflowMapDoc = await storage.getActiveDocument(
    sessionId,
    "workflow_map",
  );
  const testSuiteDoc = await storage.getActiveDocument(sessionId, "test_suite");
  if (workflowMapDoc && testSuiteDoc) {
    const workflowIds = extractWorkflowIds(workflowMapDoc.structuredData);
    const testedWorkflowIds = extractTestedWorkflowIds(
      testSuiteDoc.structuredData,
    );

    for (const wfId of workflowIds) {
      if (!testedWorkflowIds.has(wfId)) {
        failures.push(`Missing test definitions for workflow: ${wfId}`);
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// Step 2 — AI validation. Cross-references all Phase 2 artifacts.
export async function runAIValidation(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  wireframeManager: WireframeManager,
  sessionId: string,
): Promise<ValidationResultData> {
  const [contract, workflowMap, testSuite, screenInventory, testRun, wireframeFiles] =
    await Promise.all([
      storage.getActiveDocument(sessionId, "project_contract"),
      storage.getActiveDocument(sessionId, "workflow_map"),
      storage.getActiveDocument(sessionId, "test_suite"),
      storage.getActiveDocument(sessionId, "screen_inventory"),
      storage.getLatestTestRunResult(sessionId),
      wireframeManager.listFiles(sessionId),
    ]);

  const userContent = `Project Contract:
${contract?.content ?? "(not available)"}

Workflow Map:
${workflowMap?.content ?? "(not available)"}

Test Suite:
${testSuite?.content ?? "(not available)"}

Screen Inventory:
${screenInventory?.content ?? "(not available)"}

Wireframe files that exist:
${wireframeFiles.join(", ") || "(none)"}

Latest test run results:
${formatTestRun(testRun)}`;

  const def: OperationDefinition<ValidationResultData> = {
    operationId: "op-2-10",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.phase2Validation),
    messages: [{ role: "user", content: userContent }],
    expectedOutputFormat: "structured",
    outputParser: parseValidationResult,
    maxRetries: 1,
    retryPrompt:
      "Respond in format: STATUS: PASS or FAIL, then ISSUES:, WARNINGS:, SUGGESTIONS: sections.",
    timeoutMs: 60_000,
    role: "reasoning",
  };

  const result = await executor.execute<ValidationResultData>(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-10 AI validation failed: ${result.error ?? "unknown"}`);
  }

  return result.output.data;
}

// Full validation — runs code checks first, then AI validation if code checks pass.
export async function validatePhase2(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  wireframeManager: WireframeManager,
  sessionId: string,
): Promise<Phase2ValidationResult> {
  const codeChecks = await runCodeChecks(storage, wireframeManager, sessionId);

  if (!codeChecks.passed) {
    return {
      codeChecks,
      aiValidation: null,
      overall: "FAIL",
    };
  }

  const aiValidation = await runAIValidation(
    executor,
    registry,
    storage,
    wireframeManager,
    sessionId,
  );

  return {
    codeChecks,
    aiValidation,
    overall: aiValidation.status,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function extractScreenIds(structuredData: string): string[] {
  try {
    const data = parseYaml(structuredData) as Record<string, unknown>;
    const screens = (data.screens ?? []) as Record<string, unknown>[];
    return screens.map((s) => s.id as string).filter(Boolean);
  } catch {
    return [];
  }
}

function extractWorkflowIds(structuredData: string): string[] {
  try {
    const data = parseYaml(structuredData) as Record<string, unknown>;
    const workflows = (data.workflows ?? []) as Record<string, unknown>[];
    return workflows.map((w) => w.id as string).filter(Boolean);
  } catch {
    return [];
  }
}

function extractTestedWorkflowIds(structuredData: string): Set<string> {
  try {
    const data = parseYaml(structuredData) as Record<string, unknown>;
    const tests = (data.tests ?? data.testCases ?? []) as Record<string, unknown>[];
    return new Set(tests.map((t) => t.workflowId as string).filter(Boolean));
  } catch {
    return new Set();
  }
}

function formatTestRun(testRun: TestRunResult | null): string {
  if (!testRun) return "(no test run yet)";
  return `Run at: ${testRun.runAt}
Total: ${testRun.totalTests}, Passed: ${testRun.passed}, Failed: ${testRun.failed}, Known issues: ${testRun.knownIssues}
${testRun.results
  .filter((r) => r.status === "fail")
  .map((r) => `  FAIL: ${r.testName} — ${r.errorMessage ?? "no details"}`)
  .join("\n")}`;
}
