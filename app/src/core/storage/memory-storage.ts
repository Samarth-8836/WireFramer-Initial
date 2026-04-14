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

import type {
  ConversationSummary,
  IStorage,
  PendingMessage,
} from "./interface";

// In-memory mirror of FileStorage. Same contract, same semantics, no I/O.
// Used exclusively for unit tests so they stay hermetic and fast.
//
// The test suite runs the same assertions against FileStorage and MemoryStorage
// to guarantee the two behave identically.

interface SessionBucket {
  session: Session | null;
  phases: PhaseState[];
  documents: Document[];
  artifacts: Artifact[];
  messages: ChatMessage[];
  operations: OperationProgress[];
  checkpoints: Checkpoint[];
  summaries: ConversationSummary[];
  pendingMessages: PendingMessage[];
  testResults: TestRunResult[];
  cascadeSnapshots: CascadeSnapshot[];
}

function emptyBucket(): SessionBucket {
  return {
    session: null,
    phases: [],
    documents: [],
    artifacts: [],
    messages: [],
    operations: [],
    checkpoints: [],
    summaries: [],
    pendingMessages: [],
    testResults: [],
    cascadeSnapshots: [],
  };
}

// Deep-clone on read/write so callers can't mutate our internal state.
// JSON round-trip is fine here because all our records are JSON-safe.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryStorage implements IStorage {
  private readonly buckets = new Map<string, SessionBucket>();

  private getBucket(sessionId: string): SessionBucket {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = emptyBucket();
      this.buckets.set(sessionId, bucket);
    }
    return bucket;
  }

  // ---------- sessions ----------

  async createSession(session: Session): Promise<Session> {
    const bucket = this.getBucket(session.id);
    bucket.session = clone(session);
    return clone(session);
  }

  async getSession(id: string): Promise<Session | null> {
    const bucket = this.buckets.get(id);
    return bucket?.session ? clone(bucket.session) : null;
  }

  async updateSession(
    id: string,
    updates: Partial<Session>,
  ): Promise<Session> {
    const bucket = this.buckets.get(id);
    if (!bucket?.session) throw new Error(`Session not found: ${id}`);
    const next: Session = {
      ...bucket.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    bucket.session = next;
    return clone(next);
  }

  async listSessions(): Promise<Session[]> {
    const out: Session[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.session) out.push(clone(bucket.session));
    }
    out.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return out;
  }

  async deleteSession(id: string): Promise<void> {
    this.buckets.delete(id);
  }

  // ---------- phase state ----------

  async getPhaseState(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<PhaseState | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.phases.find((p) => p.phaseId === phaseId);
    return hit ? clone(hit) : null;
  }

  async upsertPhaseState(state: PhaseState): Promise<PhaseState> {
    const bucket = this.getBucket(state.sessionId);
    const idx = bucket.phases.findIndex((p) => p.phaseId === state.phaseId);
    if (idx === -1) bucket.phases.push(clone(state));
    else bucket.phases[idx] = clone(state);
    return clone(state);
  }

  // ---------- documents ----------

  async createDocument(doc: Document): Promise<Document> {
    const bucket = this.getBucket(doc.sessionId);
    for (const existing of bucket.documents) {
      if (existing.type === doc.type && existing.status === "active") {
        existing.status = "inactive";
      }
    }
    const maxVersion = bucket.documents
      .filter((d) => d.type === doc.type)
      .reduce((m, d) => Math.max(m, d.version), 0);
    const next: Document = {
      ...doc,
      version: maxVersion + 1,
      status: "active",
    };
    bucket.documents.push(clone(next));
    return clone(next);
  }

  async getActiveDocument(
    sessionId: string,
    type: DocumentType,
  ): Promise<Document | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.documents.find(
      (d) => d.type === type && d.status === "active",
    );
    return hit ? clone(hit) : null;
  }

  async getDocumentsBySession(sessionId: string): Promise<Document[]> {
    const bucket = this.buckets.get(sessionId);
    return bucket ? clone(bucket.documents) : [];
  }

  async updateDocument(
    id: string,
    updates: Partial<Document>,
  ): Promise<Document> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateDocument requires updates.sessionId");
    }
    const bucket = this.getBucket(sessionId);
    const idx = bucket.documents.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error(`Document not found: ${id}`);
    const next: Document = {
      ...bucket.documents[idx],
      ...updates,
      lastModifiedAt: new Date().toISOString(),
    };
    bucket.documents[idx] = next;
    return clone(next);
  }

  async deactivateDocuments(
    sessionId: string,
    type: DocumentType,
  ): Promise<void> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return;
    for (const d of bucket.documents) {
      if (d.type === type && d.status === "active") {
        d.status = "inactive";
      }
    }
  }

  // ---------- artifacts ----------

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    const bucket = this.getBucket(artifact.sessionId);
    bucket.artifacts.push(clone(artifact));
    return clone(artifact);
  }

  async getActiveArtifact(
    sessionId: string,
    filename: string,
  ): Promise<Artifact | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.artifacts.find(
      (a) => a.filename === filename && a.status === "active",
    );
    return hit ? clone(hit) : null;
  }

  async getArtifactsBySession(sessionId: string): Promise<Artifact[]> {
    const bucket = this.buckets.get(sessionId);
    return bucket ? clone(bucket.artifacts) : [];
  }

  async updateArtifact(
    id: string,
    updates: Partial<Artifact>,
  ): Promise<Artifact> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateArtifact requires updates.sessionId");
    }
    const bucket = this.getBucket(sessionId);
    const idx = bucket.artifacts.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error(`Artifact not found: ${id}`);
    const next: Artifact = {
      ...bucket.artifacts[idx],
      ...updates,
      lastModifiedAt: new Date().toISOString(),
    };
    bucket.artifacts[idx] = next;
    return clone(next);
  }

  // ---------- chat ----------

  async addMessage(message: ChatMessage): Promise<ChatMessage> {
    const bucket = this.getBucket(message.sessionId);
    bucket.messages.push(clone(message));
    return clone(message);
  }

  async getMessagesByPhase(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ChatMessage[]> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return [];
    return clone(
      bucket.messages
        .filter((m) => m.phaseId === phaseId)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    );
  }

  async updateMessage(
    id: string,
    updates: Partial<ChatMessage>,
  ): Promise<ChatMessage> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateMessage requires updates.sessionId");
    }
    const bucket = this.getBucket(sessionId);
    const idx = bucket.messages.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Message not found: ${id}`);
    const next: ChatMessage = { ...bucket.messages[idx], ...updates };
    bucket.messages[idx] = next;
    return clone(next);
  }

  // ---------- operation progress ----------

  async getOperationProgress(
    sessionId: string,
    operationId: OperationId,
  ): Promise<OperationProgress | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.operations.find((o) => o.operationId === operationId);
    return hit ? clone(hit) : null;
  }

  async upsertOperationProgress(
    progress: OperationProgress,
  ): Promise<OperationProgress> {
    const bucket = this.getBucket(progress.sessionId);
    const idx = bucket.operations.findIndex(
      (o) => o.operationId === progress.operationId,
    );
    if (idx === -1) bucket.operations.push(clone(progress));
    else bucket.operations[idx] = clone(progress);
    return clone(progress);
  }

  async getOperationsBySession(
    sessionId: string,
  ): Promise<OperationProgress[]> {
    const bucket = this.buckets.get(sessionId);
    return bucket ? clone(bucket.operations) : [];
  }

  // ---------- checkpoints ----------

  async createCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    const bucket = this.getBucket(checkpoint.sessionId);
    bucket.checkpoints.push(clone(checkpoint));
    return clone(checkpoint);
  }

  async getCheckpointByNumber(
    sessionId: string,
    number: number,
  ): Promise<Checkpoint | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.checkpoints.find((c) => c.number === number);
    return hit ? clone(hit) : null;
  }

  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.checkpoints.length === 0) return null;
    const latest = bucket.checkpoints.reduce((acc, c) =>
      c.number > acc.number ? c : acc,
    );
    return clone(latest);
  }

  // ---------- conversation summaries ----------

  async getConversationSummary(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ConversationSummary | null> {
    const bucket = this.buckets.get(sessionId);
    const hit = bucket?.summaries.find((s) => s.phaseId === phaseId);
    return hit ? clone(hit) : null;
  }

  async upsertConversationSummary(
    summary: ConversationSummary,
  ): Promise<ConversationSummary> {
    const bucket = this.getBucket(summary.sessionId);
    const idx = bucket.summaries.findIndex((s) => s.phaseId === summary.phaseId);
    if (idx === -1) bucket.summaries.push(clone(summary));
    else bucket.summaries[idx] = clone(summary);
    return clone(summary);
  }

  // ---------- pending messages ----------

  async createPendingMessage(msg: PendingMessage): Promise<PendingMessage> {
    const bucket = this.getBucket(msg.sessionId);
    bucket.pendingMessages.push(clone(msg));
    return clone(msg);
  }

  async getPendingMessages(sessionId: string): Promise<PendingMessage[]> {
    const bucket = this.buckets.get(sessionId);
    return bucket ? clone(bucket.pendingMessages) : [];
  }

  async updatePendingMessage(
    id: string,
    updates: Partial<PendingMessage>,
  ): Promise<PendingMessage> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updatePendingMessage requires updates.sessionId");
    }
    const bucket = this.getBucket(sessionId);
    const idx = bucket.pendingMessages.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Pending message not found: ${id}`);
    const next: PendingMessage = { ...bucket.pendingMessages[idx], ...updates };
    bucket.pendingMessages[idx] = next;
    return clone(next);
  }

  // ---------- test results ----------

  async saveTestRunResult(result: TestRunResult): Promise<TestRunResult> {
    const bucket = this.getBucket(result.sessionId);
    bucket.testResults.push(clone(result));
    return clone(result);
  }

  async getLatestTestRunResult(
    sessionId: string,
  ): Promise<TestRunResult | null> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.testResults.length === 0) return null;
    const latest = bucket.testResults.reduce((acc, r) =>
      new Date(r.runAt).getTime() > new Date(acc.runAt).getTime() ? r : acc,
    );
    return clone(latest);
  }

  // ---------- cascade snapshots ----------

  async createCascadeSnapshot(
    snapshot: CascadeSnapshot,
  ): Promise<CascadeSnapshot> {
    const bucket = this.getBucket(snapshot.sessionId);
    bucket.cascadeSnapshots.push(clone(snapshot));
    return clone(snapshot);
  }

  async getLatestCascadeSnapshot(
    sessionId: string,
  ): Promise<CascadeSnapshot | null> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.cascadeSnapshots.length === 0) return null;
    const latest = bucket.cascadeSnapshots.reduce((acc, s) =>
      new Date(s.createdAt).getTime() > new Date(acc.createdAt).getTime()
        ? s
        : acc,
    );
    return clone(latest);
  }

  async updateCascadeSnapshot(
    id: string,
    updates: Partial<CascadeSnapshot>,
  ): Promise<CascadeSnapshot> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateCascadeSnapshot requires updates.sessionId");
    }
    const bucket = this.getBucket(sessionId);
    const idx = bucket.cascadeSnapshots.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Cascade snapshot not found: ${id}`);
    const next: CascadeSnapshot = {
      ...bucket.cascadeSnapshots[idx],
      ...updates,
    };
    bucket.cascadeSnapshots[idx] = next;
    return clone(next);
  }
}
