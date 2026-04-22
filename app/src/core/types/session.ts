export type PhaseId = "phase-1" | "phase-2";

export type SessionStatus = "active" | "suspended";

export type PhaseStatus =
  | "not_started"
  | "active"
  | "completing"
  | "complete"
  | "suspended";

// Phase 2 is broken into four user-approval-gated stages. Each `_running`
// state is entered when the stage's ops are executing; each `_review`
// state is entered after the ops finish and waits for the user to
// approve (or request changes) before advancing to the next stage.
//
// Transitions:
//   not_started
//     → design_running → design_review
//     → wireframe_running → wireframe_review
//     → test_suite_running → test_suite_review
//     → automated_tests_running → complete
//
// `null` / undefined means "no phase-2 stage active yet" (Phase 1 session
// or fresh session). Backward-compatible with sessions persisted before
// the stages feature landed.
export type Phase2Stage =
  | "not_started"
  | "design_running"
  | "design_review"
  | "wireframe_running"
  | "wireframe_review"
  | "test_suite_running"
  | "test_suite_review"
  | "automated_tests_running"
  | "complete";

export interface Session {
  id: string;
  title: string;
  currentPhaseId: PhaseId;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  // Present once the session has started Phase 2. Optional for
  // backward-compat with sessions persisted before stages landed.
  phase2Stage?: Phase2Stage | null;
}

export interface PhaseState {
  sessionId: string;
  phaseId: PhaseId;
  status: PhaseStatus;
  enteredAt: string | null;
  completedAt: string | null;
  suspendedAt: string | null;
}
