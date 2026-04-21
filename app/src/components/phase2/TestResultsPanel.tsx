"use client";

import { useState } from "react";

import type { TestRunResult, IndividualTestResult } from "@core/types";

interface TestResultsPanelProps {
  results: TestRunResult | null;
  onDiagnose?: (test: IndividualTestResult) => void;
  onMarkKnownIssue?: (testId: string) => void;
}

export function TestResultsPanel({
  results,
  onDiagnose,
  onMarkKnownIssue,
}: TestResultsPanelProps) {
  const [expandedTest, setExpandedTest] = useState<string | null>(null);

  if (!results || results.totalTests === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-zinc-400">
        No test results yet. Run tests to see results.
      </div>
    );
  }

  const allPassed = results.failed === 0;

  return (
    <div className="flex flex-col overflow-y-auto">
      {/* Summary */}
      <div
        className={`border-b px-4 py-3 ${
          allPassed
            ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
            : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-lg ${allPassed ? "text-green-600" : "text-red-600"}`}>
            {allPassed ? "\u2713" : "\u2717"}
          </span>
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {results.passed} of {results.totalTests} tests passed
            {results.failed > 0 && `. ${results.failed} failed.`}
            {results.knownIssues > 0 && ` ${results.knownIssues} known issues.`}
          </span>
          <span className="text-xs text-zinc-400">
            {(results.duration / 1000).toFixed(1)}s
          </span>
        </div>
      </div>

      {/* Test list */}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {results.results.map((test) => (
          <div key={test.testId}>
            <button
              onClick={() =>
                setExpandedTest(
                  expandedTest === test.testId ? null : test.testId,
                )
              }
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <StatusIcon status={test.status} />
              <span className="flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200">
                {test.testName}
              </span>
              <span className="text-xs text-zinc-400">{test.duration}ms</span>
            </button>

            {expandedTest === test.testId && test.status === "fail" && (
              <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  <strong>Failed step:</strong>{" "}
                  {test.failedStepDescription ?? `Step ${test.failedStep}`}
                </p>
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {test.errorMessage}
                </p>
                <div className="mt-2 flex gap-2">
                  {onDiagnose && (
                    <button
                      onClick={() => onDiagnose(test)}
                      className="rounded bg-blue-500 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
                    >
                      Diagnose
                    </button>
                  )}
                  {onMarkKnownIssue && (
                    <button
                      onClick={() => onMarkKnownIssue(test.testId)}
                      className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-700"
                    >
                      Mark as known issue
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "pass") {
    return <span className="text-green-500 text-sm">{"\u2713"}</span>;
  }
  if (status === "known_issue") {
    return <span className="text-amber-500 text-sm">{"\u26A0"}</span>;
  }
  return <span className="text-red-500 text-sm">{"\u2717"}</span>;
}
