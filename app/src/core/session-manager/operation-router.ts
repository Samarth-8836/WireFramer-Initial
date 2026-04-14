import type { OperationId, PhaseId } from "@core/types";

// Given a user message and the current session state, decide which
// operation should handle it. The router is intentionally thin — all the
// real work happens in the ops themselves. Session Manager calls this once
// per incoming message to pick the handler.
//
// Phase 1:
//   - First message in a session (no documents persisted yet) → Op 1.1
//     (Goal Expansion). Creates the first Project Contract.
//   - Any subsequent message → Op 1.2 (Iteration). Updates the existing
//     Project Contract using the two-AI pattern.
//
// Phase 2:
//   - All messages route to Op 2.7a (Conversational AI in Phase 2). That
//     op handles whether the message is a question, a change request, or
//     a clarification — the router doesn't need to know.

export interface RouteMessageInput {
  phaseId: PhaseId;
  hasExistingDocuments: boolean;
}

export function routeMessage(input: RouteMessageInput): OperationId {
  if (input.phaseId === "phase-1") {
    return input.hasExistingDocuments ? "op-1-2" : "op-1-1";
  }
  return "op-2-7a";
}
