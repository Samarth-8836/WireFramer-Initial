import type { PhaseId } from "./session";

export interface DocumentSnapshot {
  documentId: string;
  content: string;
  structuredData: string;
  version: number;
}

export interface ArtifactSnapshot {
  artifactId: string;
  filename: string;
  fileContent: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  phaseId: PhaseId;
  number: number;
  createdAt: string;
  documentSnapshots: DocumentSnapshot[];
  artifactSnapshots: ArtifactSnapshot[];
}

export type CascadeSnapshotStatus = "active" | "applied" | "undone";

export interface CascadeSnapshot {
  id: string;
  sessionId: string;
  triggeredBy: string;
  createdAt: string;
  documentSnapshots: DocumentSnapshot[];
  artifactSnapshots: ArtifactSnapshot[];
  status: CascadeSnapshotStatus;
}
