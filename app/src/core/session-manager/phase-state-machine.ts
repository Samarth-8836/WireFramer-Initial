import type { PhaseId, PhaseState, PhaseStatus } from "@core/types";
import type { IStorage } from "@core/storage/interface";

// Phase state machine for the two-phase session lifecycle.
//
// A session always has exactly one currentPhaseId. Within that phase, the
// phase state transitions along a narrow path:
//
//   not_started --> active --> completing --> complete
//                      \           |
//                       \          v
//                        \----> active (on validation FAIL)
//                      \
//                       --> suspended --> active (on restore)
//
// - `not_started` is the default for any phase that hasn't been entered yet.
// - `active` is the normal working state; user input is accepted here.
// - `completing` is a short-lived state during validation (Op 1.3 / 2.9).
//   On PASS we move to `complete`; on FAIL we bounce back to `active`.
// - `complete` is terminal — the session moves forward to the next phase.
// - `suspended` is used during rollback workflows and is always reversible
//   back to `active`.

const VALID_TRANSITIONS: Record<PhaseStatus, readonly PhaseStatus[]> = {
  not_started: ["active"],
  active: ["completing", "suspended"],
  completing: ["complete", "active"],
  complete: ["active"],  // Rollback: allows re-entering a phase (Sprint 9)
  suspended: ["active"],
};

export function validateTransition(
  from: PhaseStatus,
  to: PhaseStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionPhase(
  storage: IStorage,
  sessionId: string,
  phaseId: PhaseId,
  newStatus: PhaseStatus,
): Promise<PhaseState> {
  const current = await storage.getPhaseState(sessionId, phaseId);
  if (!current) {
    throw new Error(
      `Cannot transition: no phase state for session ${sessionId} phase ${phaseId}`,
    );
  }

  if (!validateTransition(current.status, newStatus)) {
    throw new Error(
      `Invalid phase transition: ${current.status} -> ${newStatus} (session ${sessionId} phase ${phaseId})`,
    );
  }

  const now = new Date().toISOString();
  const next: PhaseState = { ...current, status: newStatus };

  // Timestamp bookkeeping — kept close to the transition logic so we can
  // reconstruct session history from phase state alone if needed.
  if (newStatus === "complete") {
    next.completedAt = now;
  }
  if (newStatus === "suspended") {
    next.suspendedAt = now;
  }
  if (newStatus === "active") {
    // Restoring from suspended also refreshes enteredAt so the UI can
    // reason about "how long have we been back in this phase".
    if (
      current.status === "not_started" ||
      current.status === "suspended" ||
      current.status === "complete"  // Rollback re-entry
    ) {
      next.enteredAt = now;
      next.completedAt = null;  // Clear completion on re-entry
    }
    // Leaving `completing -> active` (on validation FAIL) does NOT reset
    // enteredAt, since we never really left the active window.
  }

  return storage.upsertPhaseState(next);
}
