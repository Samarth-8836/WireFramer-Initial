import type {
  Artifact,
  CascadeSnapshot,
  ChatMessage,
  Checkpoint,
  Document,
  DocumentType,
  OperationId,
  OperationProgress,
  PhaseId,
  PhaseState,
  Session,
  TestRunResult,
} from "@core/types";

// Lives here rather than in types/ because it's a storage-only concern.
export interface ConversationSummary {
  sessionId: string;
  phaseId: PhaseId;
  summary: string;
  lastUpdatedAt: string;
  messagesCovered: number;
}

export type PendingMessageStatus = "pending" | "applied" | "discarded";

export interface PendingMessage {
  id: string;
  sessionId: string;
  originalMessage: string;
  changeContext: string;
  driftClassification: string;
  driftReason: string;
  createdAt: string;
  status: PendingMessageStatus;
}

// Complete CRUD contract for the persistence layer. FileStorage and
// MemoryStorage implement this identically so they're interchangeable.
// Tests in Sprint 1 run the same suite against both.
export interface IStorage {
  // Sessions
  createSession(session: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, updates: Partial<Session>): Promise<Session>;
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  // Phase state
  getPhaseState(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<PhaseState | null>;
  upsertPhaseState(state: PhaseState): Promise<PhaseState>;

  // Documents
  createDocument(doc: Document): Promise<Document>;
  getActiveDocument(
    sessionId: string,
    type: DocumentType,
  ): Promise<Document | null>;
  getDocumentsBySession(sessionId: string): Promise<Document[]>;
  updateDocument(id: string, updates: Partial<Document>): Promise<Document>;
  deactivateDocuments(sessionId: string, type: DocumentType): Promise<void>;

  // Artifacts
  createArtifact(artifact: Artifact): Promise<Artifact>;
  getActiveArtifact(
    sessionId: string,
    filename: string,
  ): Promise<Artifact | null>;
  getArtifactsBySession(sessionId: string): Promise<Artifact[]>;
  updateArtifact(id: string, updates: Partial<Artifact>): Promise<Artifact>;

  // Chat
  addMessage(message: ChatMessage): Promise<ChatMessage>;
  getMessagesByPhase(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ChatMessage[]>;
  updateMessage(
    id: string,
    updates: Partial<ChatMessage>,
  ): Promise<ChatMessage>;

  // Operation progress
  getOperationProgress(
    sessionId: string,
    operationId: OperationId,
  ): Promise<OperationProgress | null>;
  upsertOperationProgress(
    progress: OperationProgress,
  ): Promise<OperationProgress>;
  getOperationsBySession(sessionId: string): Promise<OperationProgress[]>;

  // Checkpoints
  createCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint>;
  getCheckpointByNumber(
    sessionId: string,
    number: number,
  ): Promise<Checkpoint | null>;
  getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null>;

  // Conversation summaries
  getConversationSummary(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ConversationSummary | null>;
  upsertConversationSummary(
    summary: ConversationSummary,
  ): Promise<ConversationSummary>;

  // Pending messages
  createPendingMessage(msg: PendingMessage): Promise<PendingMessage>;
  getPendingMessages(sessionId: string): Promise<PendingMessage[]>;
  updatePendingMessage(
    id: string,
    updates: Partial<PendingMessage>,
  ): Promise<PendingMessage>;

  // Test results
  saveTestRunResult(result: TestRunResult): Promise<TestRunResult>;
  getLatestTestRunResult(sessionId: string): Promise<TestRunResult | null>;

  // Cascade snapshots
  createCascadeSnapshot(snapshot: CascadeSnapshot): Promise<CascadeSnapshot>;
  getLatestCascadeSnapshot(
    sessionId: string,
  ): Promise<CascadeSnapshot | null>;
  updateCascadeSnapshot(
    id: string,
    updates: Partial<CascadeSnapshot>,
  ): Promise<CascadeSnapshot>;
}
