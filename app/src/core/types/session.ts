export type PhaseId = "phase-1" | "phase-2";

export type SessionStatus = "active" | "suspended";

export type PhaseStatus =
  | "not_started"
  | "active"
  | "completing"
  | "complete"
  | "suspended";

export interface Session {
  id: string;
  title: string;
  currentPhaseId: PhaseId;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
}

export interface PhaseState {
  sessionId: string;
  phaseId: PhaseId;
  status: PhaseStatus;
  enteredAt: string | null;
  completedAt: string | null;
  suspendedAt: string | null;
}
