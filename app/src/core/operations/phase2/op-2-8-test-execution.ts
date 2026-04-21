// Op 2.8 — Test Execution.
//
// Runs tests against the wireframe prototype. In Sprint 8 this is a
// stub that reads the tests.js file and returns a "not executed"
// result. The real Playwright implementation requires the dev server
// running and is deferred to Sprint 11 (E2E hardening).
//
// When Playwright is available, the flow is:
//   1. Launch headless browser
//   2. Load /api/wireframe/:sessionId/test-harness.html
//   3. Evaluate runTests(TEST_DEFINITIONS)
//   4. Wait for testsComplete event → collect results

import { v4 as uuidv4 } from "uuid";

import { WireframeManager } from "@core/wireframe/wireframe-manager";
import type { TestRunResult } from "@core/types";

export async function executeTestRun(
  wireframeManager: WireframeManager,
  sessionId: string,
): Promise<TestRunResult> {
  // Check if test files exist.
  let testsJsExists = false;
  try {
    await wireframeManager.readFile(sessionId, "tests.js");
    testsJsExists = true;
  } catch {
    // No tests.js — can't run.
  }

  if (!testsJsExists) {
    return {
      id: uuidv4(),
      sessionId,
      runAt: new Date().toISOString(),
      totalTests: 0,
      passed: 0,
      failed: 0,
      knownIssues: 0,
      duration: 0,
      results: [],
    };
  }

  // Placeholder: Playwright-based execution is Sprint 11.
  // For now, return a result indicating tests exist but weren't executed.
  return {
    id: uuidv4(),
    sessionId,
    runAt: new Date().toISOString(),
    totalTests: 0,
    passed: 0,
    failed: 0,
    knownIssues: 0,
    duration: 0,
    results: [],
  };
}
