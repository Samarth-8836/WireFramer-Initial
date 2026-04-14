import type { PhaseId } from "./session";

export type DocumentType =
  | "project_contract"
  | "workflow_map"
  | "test_suite"
  | "screen_inventory";

export type DocumentStatus = "active" | "inactive";

export interface Document {
  id: string;
  sessionId: string;
  phaseId: PhaseId;
  type: DocumentType;
  content: string;
  structuredData: string;
  version: number;
  status: DocumentStatus;
  createdAt: string;
  lastModifiedAt: string;
}
