// Session resumability — Sprint 10.
//
// On server restart, scans sessions for in-progress operations and marks
// them as failed so the UI can surface retry options. Full auto-resume of
// the DAG mid-flight is intentionally deferred — the deterministic safe
// behavior is to mark interrupted operations as failed and let the user
// retry or regenerate.

import type { IStorage } from "@core/storage";
import type { OperationProgress, Session } from "@core/types";

export interface ResumeReport {
  sessionsScanned: number;
  interruptedOperations: InterruptedOperation[];
}

export interface InterruptedOperation {
  sessionId: string;
  operationId: string;
  previousStatus: string;
}

// Scan all sessions for in-progress operations left over from a crash
// or restart. Marks them as "failed" with a descriptive error so the UI
// can show a retry option.
export async function resumeInterruptedSessions(
  storage: IStorage,
): Promise<ResumeReport> {
  const sessions = await storage.listSessions();
  const interrupted: InterruptedOperation[] = [];

  for (const session of sessions) {
    const ops = await scanSessionForInterrupted(storage, session);
    interrupted.push(...ops);
  }

  // Mark each interrupted operation as failed.
  for (const op of interrupted) {
    await storage.upsertOperationProgress({
      sessionId: op.sessionId,
      operationId: op.operationId as OperationProgress["operationId"],
      status: "failed",
      startedAt: null,
      completedAt: new Date().toISOString(),
      error: "Operation was interrupted by server restart. Please retry.",
      batchItems: null,
    });
  }

  return {
    sessionsScanned: sessions.length,
    interruptedOperations: interrupted,
  };
}

async function scanSessionForInterrupted(
  storage: IStorage,
  session: Session,
): Promise<InterruptedOperation[]> {
  const ops = await storage.getOperationsBySession(session.id);
  return ops
    .filter((op) => op.status === "in_progress")
    .map((op) => ({
      sessionId: session.id,
      operationId: op.operationId,
      previousStatus: op.status,
    }));
}
