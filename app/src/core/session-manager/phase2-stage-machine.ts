// Phase 2 stage machine.
//
// Phase 2 used to run as one monolithic DAG — 20 ops, 5-10 minutes,
// no user feedback until everything finished. Now it runs in four
// user-approval-gated stages so the user can review + course-correct
// after each milestone:
//
//   design          — workflow map + screen inventory
//   wireframe       — dummy data, HTML shell, per-screen HTML, smoke
//   test_suite      — test cases + coverage + test suite doc
//   automated_tests — test harness, translation, dry run, repair
//
// Each stage has two states: `<stage>_running` (ops executing) and
// `<stage>_review` (waiting for user approval). The user's approve
// action transitions from `_review` into the next stage's `_running`.
//
// This module owns the transition table + the storage-level helpers
// for stepping forward. The actual stage ops live in
// phase2-handlers.ts.

import type { IStorage } from "@core/storage";
import type { Phase2Stage, Session } from "@core/types";

// Ordered list of stages, in the order the user goes through them.
export const PHASE2_STAGE_ORDER: readonly Phase2Stage[] = [
  "not_started",
  "design_running",
  "design_review",
  "wireframe_running",
  "wireframe_review",
  "test_suite_running",
  "test_suite_review",
  "automated_tests_running",
  "complete",
] as const;

// The "running" stages — used by UI to show the spinner / progress state.
export const RUNNING_STAGES: ReadonlySet<Phase2Stage> = new Set([
  "design_running",
  "wireframe_running",
  "test_suite_running",
  "automated_tests_running",
]);

// The "review" stages — used by UI to show the Approve button.
export const REVIEW_STAGES: ReadonlySet<Phase2Stage> = new Set([
  "design_review",
  "wireframe_review",
  "test_suite_review",
]);

// Which stage comes after a review. If the session is currently in
// `design_review` and the user approves, we want to transition into
// `wireframe_running`. For `automated_tests` there is no further stage
// and the review state is skipped — we go directly from running to
// complete.
const NEXT_RUNNING_AFTER_REVIEW: Partial<Record<Phase2Stage, Phase2Stage>> = {
  design_review: "wireframe_running",
  wireframe_review: "test_suite_running",
  test_suite_review: "automated_tests_running",
};

// Which stage each `_running` state transitions to on completion.
const REVIEW_AFTER_RUNNING: Partial<Record<Phase2Stage, Phase2Stage>> = {
  design_running: "design_review",
  wireframe_running: "wireframe_review",
  test_suite_running: "test_suite_review",
  automated_tests_running: "complete",
};

// Valid manual advance transitions (i.e. transitions requested by the
// user's "Approve" click). Only review → next running is allowed.
export function canAdvanceStage(current: Phase2Stage | null | undefined): {
  ok: boolean;
  next: Phase2Stage | null;
  reason: string | null;
} {
  const stage = current ?? "not_started";
  const next = NEXT_RUNNING_AFTER_REVIEW[stage];
  if (next) return { ok: true, next, reason: null };
  return {
    ok: false,
    next: null,
    reason: `Cannot advance from stage ${stage}. Advance requires a *_review state (user has approved the current stage's output).`,
  };
}

// Called after a stage's ops finish. Computes the appropriate next stage
// (usually `<stage>_review`, or `complete` for the last stage).
export function stageAfterRunning(running: Phase2Stage): Phase2Stage {
  const next = REVIEW_AFTER_RUNNING[running];
  if (!next) {
    throw new Error(
      `No post-running transition defined for ${running} — expected a _running state.`,
    );
  }
  return next;
}

// Persist a new stage on the session record.
export async function setPhase2Stage(
  storage: IStorage,
  sessionId: string,
  stage: Phase2Stage,
): Promise<Session> {
  return storage.updateSession(sessionId, { phase2Stage: stage });
}

// Read the current stage (treating missing as "not_started" so legacy
// sessions without the field still behave predictably).
export async function getPhase2Stage(
  storage: IStorage,
  sessionId: string,
): Promise<Phase2Stage> {
  const session = await storage.getSession(sessionId);
  return session?.phase2Stage ?? "not_started";
}

// Helpers used by UI state code.
export function isRunning(stage: Phase2Stage | null | undefined): boolean {
  return RUNNING_STAGES.has((stage ?? "not_started") as Phase2Stage);
}

export function isReview(stage: Phase2Stage | null | undefined): boolean {
  return REVIEW_STAGES.has((stage ?? "not_started") as Phase2Stage);
}
