export type OperationId =
  | "op-1-0"
  | "op-1-1"
  | "op-1-2"
  | "op-1-3"
  | "op-2-1a"
  | "op-2-1b"
  | "op-2-1c"
  | "op-2-2a"
  | "op-2-2b"
  | "op-2-2c"
  | "op-2-3a"
  | "op-2-3b"
  | "op-2-3c"
  | "op-2-3d"
  | "op-2-4a"
  | "op-2-4b"
  | "op-2-4c"
  | "op-2-4d"
  | "op-2-4e"
  | "op-2-5a"
  | "op-2-5b"
  | "op-2-5c"
  | "op-2-5d"
  | "op-2-5e"
  | "op-2-6"
  | "op-2-7a"
  | "op-2-7b"
  | "op-2-7c"
  | "op-2-7d"
  | "op-2-7e"
  | "op-2-7f"
  | "op-2-7g"
  | "op-2-7h"
  | "op-2-7i"
  | "op-2-8"
  | "op-2-9"
  | "op-2-10";

export type OperationStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "failed"
  | "skipped";

export interface BatchItem {
  itemId: string;
  itemName: string;
  status: OperationStatus;
  error: string | null;
  retryCount: number;
}

export interface OperationProgress {
  sessionId: string;
  operationId: OperationId;
  status: OperationStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  batchItems: BatchItem[] | null;
}
