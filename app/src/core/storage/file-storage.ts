import { promises as fs } from "node:fs";
import path from "node:path";

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

// File layout, per session:
//   <dataDir>/sessions/<sessionId>/
//     session.json           Session
//     phases.json            PhaseState[]
//     documents.json         Document[]
//     artifacts.json         Artifact[]
//     messages.json          ChatMessage[]
//     operations.json        OperationProgress[]
//     checkpoints.json       Checkpoint[]
//     summaries.json         ConversationSummary[]
//     pending-messages.json  PendingMessage[]
//     test-results.json      TestRunResult[]
//     cascade-snapshots.json CascadeSnapshot[]
//     wireframe/             HTML/JS/CSS files (managed by WireframeManager)
//
// Writes are atomic: write to <file>.tmp, then rename over <file>. On the same
// filesystem, rename is atomic on both POSIX and NTFS.

const F = {
  session: "session.json",
  phases: "phases.json",
  documents: "documents.json",
  artifacts: "artifacts.json",
  messages: "messages.json",
  operations: "operations.json",
  checkpoints: "checkpoints.json",
  summaries: "summaries.json",
  pendingMessages: "pending-messages.json",
  testResults: "test-results.json",
  cascadeSnapshots: "cascade-snapshots.json",
} as const;

export class FileStorage implements IStorage {
  constructor(private readonly dataDir: string) {}

  // ---------- path helpers ----------

  private sessionDir(sessionId: string): string {
    return path.join(this.dataDir, "sessions", sessionId);
  }

  private sessionFile(sessionId: string, filename: string): string {
    return path.join(this.sessionDir(sessionId), filename);
  }

  // ---------- collection read/write ----------

  private async readCollection<T>(
    sessionId: string,
    filename: string,
  ): Promise<T[]> {
    const filePath = this.sessionFile(sessionId, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeCollection<T>(
    sessionId: string,
    filename: string,
    data: T[],
  ): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.sessionFile(sessionId, filename);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  private async readSingleton<T>(
    sessionId: string,
    filename: string,
  ): Promise<T | null> {
    const filePath = this.sessionFile(sessionId, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeSingleton<T>(
    sessionId: string,
    filename: string,
    data: T,
  ): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.sessionFile(sessionId, filename);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  // ---------- sessions ----------

  async createSession(session: Session): Promise<Session> {
    await this.writeSingleton<Session>(session.id, F.session, session);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.readSingleton<Session>(id, F.session);
  }

  async updateSession(
    id: string,
    updates: Partial<Session>,
  ): Promise<Session> {
    const existing = await this.getSession(id);
    if (!existing) throw new Error(`Session not found: ${id}`);
    const next: Session = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.writeSingleton<Session>(id, F.session, next);
    return next;
  }

  async listSessions(): Promise<Session[]> {
    const sessionsDir = path.join(this.dataDir, "sessions");
    let dirs: string[];
    try {
      dirs = await fs.readdir(sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Session[] = [];
    for (const dir of dirs) {
      const s = await this.getSession(dir);
      if (s) out.push(s);
    }
    out.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return out;
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir(id);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ---------- phase state ----------

  async getPhaseState(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<PhaseState | null> {
    const list = await this.readCollection<PhaseState>(sessionId, F.phases);
    return list.find((p) => p.phaseId === phaseId) ?? null;
  }

  async upsertPhaseState(state: PhaseState): Promise<PhaseState> {
    const list = await this.readCollection<PhaseState>(
      state.sessionId,
      F.phases,
    );
    const idx = list.findIndex((p) => p.phaseId === state.phaseId);
    if (idx === -1) list.push(state);
    else list[idx] = state;
    await this.writeCollection<PhaseState>(state.sessionId, F.phases, list);
    return state;
  }

  // ---------- documents ----------

  async createDocument(doc: Document): Promise<Document> {
    const list = await this.readCollection<Document>(doc.sessionId, F.documents);

    // Deactivate any existing active docs of the same type.
    for (const existing of list) {
      if (existing.type === doc.type && existing.status === "active") {
        existing.status = "inactive";
      }
    }

    // Next version for this type.
    const maxVersion = list
      .filter((d) => d.type === doc.type)
      .reduce((m, d) => Math.max(m, d.version), 0);

    const next: Document = {
      ...doc,
      version: maxVersion + 1,
      status: "active",
    };
    list.push(next);
    await this.writeCollection<Document>(doc.sessionId, F.documents, list);
    return next;
  }

  async getActiveDocument(
    sessionId: string,
    type: DocumentType,
  ): Promise<Document | null> {
    const list = await this.readCollection<Document>(sessionId, F.documents);
    return (
      list.find((d) => d.type === type && d.status === "active") ?? null
    );
  }

  async getDocumentsBySession(sessionId: string): Promise<Document[]> {
    return this.readCollection<Document>(sessionId, F.documents);
  }

  async updateDocument(
    id: string,
    updates: Partial<Document>,
  ): Promise<Document> {
    // Docs are partitioned by sessionId, so we need a hint from the caller.
    // The updates payload must include sessionId OR we scan all sessions.
    // We take the ergonomic path: require sessionId in updates.
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateDocument requires updates.sessionId");
    }
    const list = await this.readCollection<Document>(sessionId, F.documents);
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error(`Document not found: ${id}`);
    const next: Document = {
      ...list[idx],
      ...updates,
      lastModifiedAt: new Date().toISOString(),
    };
    list[idx] = next;
    await this.writeCollection<Document>(sessionId, F.documents, list);
    return next;
  }

  async deactivateDocuments(
    sessionId: string,
    type: DocumentType,
  ): Promise<void> {
    const list = await this.readCollection<Document>(sessionId, F.documents);
    let changed = false;
    for (const d of list) {
      if (d.type === type && d.status === "active") {
        d.status = "inactive";
        changed = true;
      }
    }
    if (changed) {
      await this.writeCollection<Document>(sessionId, F.documents, list);
    }
  }

  // ---------- artifacts ----------

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    const list = await this.readCollection<Artifact>(
      artifact.sessionId,
      F.artifacts,
    );
    list.push(artifact);
    await this.writeCollection<Artifact>(
      artifact.sessionId,
      F.artifacts,
      list,
    );
    return artifact;
  }

  async getActiveArtifact(
    sessionId: string,
    filename: string,
  ): Promise<Artifact | null> {
    const list = await this.readCollection<Artifact>(sessionId, F.artifacts);
    return (
      list.find((a) => a.filename === filename && a.status === "active") ??
      null
    );
  }

  async getArtifactsBySession(sessionId: string): Promise<Artifact[]> {
    return this.readCollection<Artifact>(sessionId, F.artifacts);
  }

  async updateArtifact(
    id: string,
    updates: Partial<Artifact>,
  ): Promise<Artifact> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateArtifact requires updates.sessionId");
    }
    const list = await this.readCollection<Artifact>(sessionId, F.artifacts);
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error(`Artifact not found: ${id}`);
    const next: Artifact = {
      ...list[idx],
      ...updates,
      lastModifiedAt: new Date().toISOString(),
    };
    list[idx] = next;
    await this.writeCollection<Artifact>(sessionId, F.artifacts, list);
    return next;
  }

  // ---------- chat ----------

  async addMessage(message: ChatMessage): Promise<ChatMessage> {
    const list = await this.readCollection<ChatMessage>(
      message.sessionId,
      F.messages,
    );
    list.push(message);
    await this.writeCollection<ChatMessage>(
      message.sessionId,
      F.messages,
      list,
    );
    return message;
  }

  async getMessagesByPhase(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ChatMessage[]> {
    const list = await this.readCollection<ChatMessage>(sessionId, F.messages);
    return list
      .filter((m) => m.phaseId === phaseId)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
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
    const list = await this.readCollection<ChatMessage>(sessionId, F.messages);
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Message not found: ${id}`);
    const next: ChatMessage = { ...list[idx], ...updates };
    list[idx] = next;
    await this.writeCollection<ChatMessage>(sessionId, F.messages, list);
    return next;
  }

  // ---------- operation progress ----------

  async getOperationProgress(
    sessionId: string,
    operationId: OperationId,
  ): Promise<OperationProgress | null> {
    const list = await this.readCollection<OperationProgress>(
      sessionId,
      F.operations,
    );
    return list.find((o) => o.operationId === operationId) ?? null;
  }

  async upsertOperationProgress(
    progress: OperationProgress,
  ): Promise<OperationProgress> {
    const list = await this.readCollection<OperationProgress>(
      progress.sessionId,
      F.operations,
    );
    const idx = list.findIndex((o) => o.operationId === progress.operationId);
    if (idx === -1) list.push(progress);
    else list[idx] = progress;
    await this.writeCollection<OperationProgress>(
      progress.sessionId,
      F.operations,
      list,
    );
    return progress;
  }

  async getOperationsBySession(
    sessionId: string,
  ): Promise<OperationProgress[]> {
    return this.readCollection<OperationProgress>(sessionId, F.operations);
  }

  // ---------- checkpoints ----------

  async createCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    const list = await this.readCollection<Checkpoint>(
      checkpoint.sessionId,
      F.checkpoints,
    );
    list.push(checkpoint);
    await this.writeCollection<Checkpoint>(
      checkpoint.sessionId,
      F.checkpoints,
      list,
    );
    return checkpoint;
  }

  async getCheckpointByNumber(
    sessionId: string,
    number: number,
  ): Promise<Checkpoint | null> {
    const list = await this.readCollection<Checkpoint>(
      sessionId,
      F.checkpoints,
    );
    return list.find((c) => c.number === number) ?? null;
  }

  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const list = await this.readCollection<Checkpoint>(
      sessionId,
      F.checkpoints,
    );
    if (list.length === 0) return null;
    return list.reduce((acc, c) => (c.number > acc.number ? c : acc));
  }

  // ---------- conversation summaries ----------

  async getConversationSummary(
    sessionId: string,
    phaseId: PhaseId,
  ): Promise<ConversationSummary | null> {
    const list = await this.readCollection<ConversationSummary>(
      sessionId,
      F.summaries,
    );
    return list.find((s) => s.phaseId === phaseId) ?? null;
  }

  async upsertConversationSummary(
    summary: ConversationSummary,
  ): Promise<ConversationSummary> {
    const list = await this.readCollection<ConversationSummary>(
      summary.sessionId,
      F.summaries,
    );
    const idx = list.findIndex((s) => s.phaseId === summary.phaseId);
    if (idx === -1) list.push(summary);
    else list[idx] = summary;
    await this.writeCollection<ConversationSummary>(
      summary.sessionId,
      F.summaries,
      list,
    );
    return summary;
  }

  // ---------- pending messages ----------

  async createPendingMessage(msg: PendingMessage): Promise<PendingMessage> {
    const list = await this.readCollection<PendingMessage>(
      msg.sessionId,
      F.pendingMessages,
    );
    list.push(msg);
    await this.writeCollection<PendingMessage>(
      msg.sessionId,
      F.pendingMessages,
      list,
    );
    return msg;
  }

  async getPendingMessages(sessionId: string): Promise<PendingMessage[]> {
    return this.readCollection<PendingMessage>(sessionId, F.pendingMessages);
  }

  async updatePendingMessage(
    id: string,
    updates: Partial<PendingMessage>,
  ): Promise<PendingMessage> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updatePendingMessage requires updates.sessionId");
    }
    const list = await this.readCollection<PendingMessage>(
      sessionId,
      F.pendingMessages,
    );
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Pending message not found: ${id}`);
    const next: PendingMessage = { ...list[idx], ...updates };
    list[idx] = next;
    await this.writeCollection<PendingMessage>(
      sessionId,
      F.pendingMessages,
      list,
    );
    return next;
  }

  // ---------- test results ----------

  async saveTestRunResult(result: TestRunResult): Promise<TestRunResult> {
    const list = await this.readCollection<TestRunResult>(
      result.sessionId,
      F.testResults,
    );
    list.push(result);
    await this.writeCollection<TestRunResult>(
      result.sessionId,
      F.testResults,
      list,
    );
    return result;
  }

  async getLatestTestRunResult(
    sessionId: string,
  ): Promise<TestRunResult | null> {
    const list = await this.readCollection<TestRunResult>(
      sessionId,
      F.testResults,
    );
    if (list.length === 0) return null;
    return list.reduce((acc, r) =>
      new Date(r.runAt).getTime() > new Date(acc.runAt).getTime() ? r : acc,
    );
  }

  // ---------- cascade snapshots ----------

  async createCascadeSnapshot(
    snapshot: CascadeSnapshot,
  ): Promise<CascadeSnapshot> {
    const list = await this.readCollection<CascadeSnapshot>(
      snapshot.sessionId,
      F.cascadeSnapshots,
    );
    list.push(snapshot);
    await this.writeCollection<CascadeSnapshot>(
      snapshot.sessionId,
      F.cascadeSnapshots,
      list,
    );
    return snapshot;
  }

  async getLatestCascadeSnapshot(
    sessionId: string,
  ): Promise<CascadeSnapshot | null> {
    const list = await this.readCollection<CascadeSnapshot>(
      sessionId,
      F.cascadeSnapshots,
    );
    if (list.length === 0) return null;
    return list.reduce((acc, s) =>
      new Date(s.createdAt).getTime() > new Date(acc.createdAt).getTime()
        ? s
        : acc,
    );
  }

  async updateCascadeSnapshot(
    id: string,
    updates: Partial<CascadeSnapshot>,
  ): Promise<CascadeSnapshot> {
    const sessionId = updates.sessionId;
    if (!sessionId) {
      throw new Error("updateCascadeSnapshot requires updates.sessionId");
    }
    const list = await this.readCollection<CascadeSnapshot>(
      sessionId,
      F.cascadeSnapshots,
    );
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Cascade snapshot not found: ${id}`);
    const next: CascadeSnapshot = { ...list[idx], ...updates };
    list[idx] = next;
    await this.writeCollection<CascadeSnapshot>(
      sessionId,
      F.cascadeSnapshots,
      list,
    );
    return next;
  }
}
