"use client";

import { useSessionStore } from "@stores/session-store";
import { useSSE } from "@lib/use-sse";

// Shown between the chat log and the input when Phase 2 is waiting for
// the user to approve the current stage's output. Clicking it starts
// the next stage on a fresh SSE stream.
//
// Visible for stages: design_review, wireframe_review, test_suite_review.
// After automated_tests_running completes the stage machine goes straight
// to `complete` — no review for the final stage, the user just clicks
// Done to run Phase 2 validation.

const STAGE_LABELS: Record<string, { title: string; next: string }> = {
  design_review: {
    title: "Design stage complete",
    next: "Generate Wireframe",
  },
  wireframe_review: {
    title: "Wireframe ready",
    next: "Generate Test Suite",
  },
  test_suite_review: {
    title: "Test Suite ready",
    next: "Generate Automated Tests",
  },
};

export function ApproveStageButton() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const phase2Stage = useSessionStore((s) => s.phase2Stage);
  const { advancePhase2Stage } = useSSE();

  if (!activeSessionId || !phase2Stage) return null;
  const label = STAGE_LABELS[phase2Stage];
  if (!label) return null;

  return (
    <div className="mx-4 mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
            {label.title}
          </p>
          <p className="mt-0.5 text-xs text-blue-700 dark:text-blue-300">
            Review the output in the document panel. When ready, continue
            to the next stage — or type feedback in the chat and we&apos;ll
            revise.
          </p>
        </div>
        <button
          onClick={() => advancePhase2Stage(activeSessionId)}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Approve → {label.next}
        </button>
      </div>
    </div>
  );
}
