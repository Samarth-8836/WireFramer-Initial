"use client";

import { useChatStore } from "@stores/chat-store";
import { useSessionStore } from "@stores/session-store";
import { useSSE } from "@lib/use-sse";

// Drift warning banner displayed when Phase 2 detects a change that
// conflicts (DRIFT) or might conflict (FLAG) with the locked contract.
//
// FLAG — yellow warning, user can "Continue anyway" or "Go back to Phase 1"
// DRIFT — red stop, user can only "Go back to Phase 1"

export function DriftWarningBanner() {
  const driftWarning = useChatStore((s) => s.driftWarning);
  const dismissDriftWarning = useChatStore((s) => s.dismissDriftWarning);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { sendMessage } = useSSE();

  if (!driftWarning) return null;

  const isDrift = driftWarning.classification === "DRIFT";

  const handleRollback = () => {
    if (!activeSessionId) return;
    dismissDriftWarning();
    // Trigger rollback via API.
    void fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeSessionId }),
    });
  };

  const handleContinue = () => {
    dismissDriftWarning();
  };

  return (
    <div
      className={`mx-4 mb-3 rounded-lg border px-4 py-3 ${
        isDrift
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
          : "border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg">
          {isDrift ? "\u26D4" : "\u26A0\uFE0F"}
        </span>
        <div className="flex-1">
          <p
            className={`text-sm font-medium ${
              isDrift
                ? "text-red-800 dark:text-red-200"
                : "text-yellow-800 dark:text-yellow-200"
            }`}
          >
            {isDrift ? "Change Blocked — Contract Drift" : "Warning — Possible Drift"}
          </p>
          <p
            className={`mt-1 text-xs ${
              isDrift
                ? "text-red-700 dark:text-red-300"
                : "text-yellow-700 dark:text-yellow-300"
            }`}
          >
            {driftWarning.reason}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleRollback}
              className={`rounded px-3 py-1.5 text-xs font-medium ${
                isDrift
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200"
              }`}
            >
              Go back to Phase 1
            </button>
            {!isDrift && (
              <button
                onClick={handleContinue}
                className="rounded bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
              >
                Continue anyway
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
