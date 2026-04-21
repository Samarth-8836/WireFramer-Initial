import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import { runCodeChecks } from "../op-2-10-validation";

describe("runCodeChecks", () => {
  function makeStorage(): MemoryStorage {
    return new MemoryStorage();
  }

  // Use a temporary directory for wireframe files.
  function makeWireframeManager(): WireframeManager {
    return new WireframeManager("./test-data-temp");
  }

  it("fails when no test run exists", async () => {
    const storage = makeStorage();
    const wm = makeWireframeManager();
    const result = await runCodeChecks(storage, wm, "session-1");

    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Please run the test suite at least once before completing this phase.",
    );
  });

  it("fails when tests are failing", async () => {
    const storage = makeStorage();
    const wm = makeWireframeManager();

    // Create a test run with failures.
    await storage.saveTestRunResult({
      id: "run-1",
      sessionId: "session-1",
      runAt: new Date().toISOString(),
      totalTests: 3,
      passed: 2,
      failed: 1,
      knownIssues: 0,
      duration: 1000,
      results: [
        {
          testId: "t1",
          testName: "test-pass-1",
          workflowId: "wf-1",
          status: "pass",
          duration: 100,
          failedStep: null,
          failedStepDescription: null,
          errorMessage: null,
        },
        {
          testId: "t2",
          testName: "test-pass-2",
          workflowId: "wf-1",
          status: "pass",
          duration: 100,
          failedStep: null,
          failedStepDescription: null,
          errorMessage: null,
        },
        {
          testId: "t3",
          testName: "test-fail-1",
          workflowId: "wf-2",
          status: "fail",
          duration: 200,
          failedStep: 3,
          failedStepDescription: "Click submit button",
          errorMessage: "Element not found",
        },
      ],
    });

    const result = await runCodeChecks(storage, wm, "session-1");
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("1 test(s) are still failing"))).toBe(true);
  });

  it("passes when all tests pass and no other issues", async () => {
    const storage = makeStorage();
    const wm = makeWireframeManager();

    // Create a passing test run.
    await storage.saveTestRunResult({
      id: "run-1",
      sessionId: "session-1",
      runAt: new Date().toISOString(),
      totalTests: 1,
      passed: 1,
      failed: 0,
      knownIssues: 0,
      duration: 100,
      results: [
        {
          testId: "t1",
          testName: "test-1",
          workflowId: "wf-1",
          status: "pass",
          duration: 100,
          failedStep: null,
          failedStepDescription: null,
          errorMessage: null,
        },
      ],
    });

    const result = await runCodeChecks(storage, wm, "session-1");
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("treats known_issues as passing", async () => {
    const storage = makeStorage();
    const wm = makeWireframeManager();

    await storage.saveTestRunResult({
      id: "run-1",
      sessionId: "session-1",
      runAt: new Date().toISOString(),
      totalTests: 2,
      passed: 1,
      failed: 0,
      knownIssues: 1,
      duration: 200,
      results: [
        {
          testId: "t1",
          testName: "test-pass",
          workflowId: "wf-1",
          status: "pass",
          duration: 100,
          failedStep: null,
          failedStepDescription: null,
          errorMessage: null,
        },
        {
          testId: "t2",
          testName: "test-known-issue",
          workflowId: "wf-2",
          status: "known_issue",
          duration: 100,
          failedStep: null,
          failedStepDescription: null,
          errorMessage: null,
        },
      ],
    });

    const result = await runCodeChecks(storage, wm, "session-1");
    expect(result.passed).toBe(true);
  });
});
