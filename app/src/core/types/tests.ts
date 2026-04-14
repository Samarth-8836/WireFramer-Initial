export type TestStatus = "pass" | "fail" | "known_issue";

export interface IndividualTestResult {
  testId: string;
  testName: string;
  workflowId: string;
  status: TestStatus;
  duration: number;
  failedStep: number | null;
  failedStepDescription: string | null;
  errorMessage: string | null;
}

export interface TestRunResult {
  id: string;
  sessionId: string;
  runAt: string;
  totalTests: number;
  passed: number;
  failed: number;
  knownIssues: number;
  duration: number;
  results: IndividualTestResult[];
}
