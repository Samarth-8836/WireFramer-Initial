import type { PhaseId } from "./session";
import type { OperationId } from "./operations";

export type MessageRole = "user" | "assistant" | "system";

export type MessageType =
  | "chat"
  | "system_notification"
  | "drift_warning"
  | "validation_result"
  | "test_results"
  | "diagnosis_result"
  | "operation_failure";

export interface MessageMetadata {
  screenReference: string | null;
  generationContext: string | null;
  operationId: OperationId | null;
  stale: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  phaseId: PhaseId;
  role: MessageRole;
  type: MessageType;
  content: string;
  metadata: MessageMetadata;
  createdAt: string;
}
