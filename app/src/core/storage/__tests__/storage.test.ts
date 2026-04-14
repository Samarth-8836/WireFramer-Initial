import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  Artifact,
  CascadeSnapshot,
  ChatMessage,
  Checkpoint,
  Document,
  OperationProgress,
  PhaseState,
  Session,
  TestRunResult,
} from "@core/types";
import { FileStorage } from "../file-storage";
import { MemoryStorage } from "../memory-storage";
import type {
  ConversationSummary,
  IStorage,
  PendingMessage,
} from "../interface";

// ---------- fixtures ----------

let counter = 0;
function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${counter}-${Date.now()}`;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? uid("session");
  const now = new Date().toISOString();
  return {
    id,
    title: "Untitled",
    currentPhaseId: "phase-1",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

function makeDocument(
  sessionId: string,
  overrides: Partial<Document> = {},
): Document {
  const now = new Date().toISOString();
  return {
    id: uid("doc"),
    sessionId,
    phaseId: "phase-1",
    type: "project_contract",
    content: "# Contract\n\nv1 body",
    structuredData: "key: value",
    version: 0, // overwritten by createDocument
    status: "active",
    createdAt: now,
    lastModifiedAt: now,
    ...overrides,
  };
}

function makeArtifact(
  sessionId: string,
  overrides: Partial<Artifact> = {},
): Artifact {
  const now = new Date().toISOString();
  return {
    id: uid("artifact"),
    sessionId,
    type: "wireframe_screen",
    filename: "home.html",
    filePath: `data/sessions/${sessionId}/wireframe/home.html`,
    relatedScreenId: "screen-home",
    status: "generating",
    createdAt: now,
    lastModifiedAt: now,
    ...overrides,
  };
}

function makeMessage(
  sessionId: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: uid("msg"),
    sessionId,
    phaseId: "phase-1",
    role: "user",
    type: "chat",
    content: "hello",
    metadata: {
      screenReference: null,
      generationContext: null,
      operationId: null,
      stale: false,
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOperationProgress(
  sessionId: string,
  overrides: Partial<OperationProgress> = {},
): OperationProgress {
  return {
    sessionId,
    operationId: "op-1-0",
    status: "in_progress",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    batchItems: null,
    ...overrides,
  };
}

function makePhaseState(
  sessionId: string,
  overrides: Partial<PhaseState> = {},
): PhaseState {
  return {
    sessionId,
    phaseId: "phase-1",
    status: "active",
    enteredAt: new Date().toISOString(),
    completedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

function makeCheckpoint(
  sessionId: string,
  number: number,
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    id: uid("cp"),
    sessionId,
    phaseId: "phase-1",
    number,
    createdAt: new Date(Date.now() + number).toISOString(),
    documentSnapshots: [
      {
        documentId: "doc-1",
        content: "snapshot content",
        structuredData: "key: snap",
        version: 1,
      },
    ],
    artifactSnapshots: [
      {
        artifactId: "art-1",
        filename: "home.html",
        fileContent: "<html></html>",
      },
    ],
    ...overrides,
  };
}

function makeSummary(
  sessionId: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    sessionId,
    phaseId: "phase-1",
    summary: "user wants a recipe app",
    lastUpdatedAt: new Date().toISOString(),
    messagesCovered: 8,
    ...overrides,
  };
}

function makePendingMessage(
  sessionId: string,
  overrides: Partial<PendingMessage> = {},
): PendingMessage {
  return {
    id: uid("pending"),
    sessionId,
    originalMessage: "Add export to PDF",
    changeContext: "<change_context>...</change_context>",
    driftClassification: "FLAG",
    driftReason: "Adds new feature post-lock",
    createdAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeTestRun(
  sessionId: string,
  overrides: Partial<TestRunResult> = {},
): TestRunResult {
  return {
    id: uid("run"),
    sessionId,
    runAt: new Date().toISOString(),
    totalTests: 3,
    passed: 2,
    failed: 1,
    knownIssues: 0,
    duration: 1200,
    results: [
      {
        testId: "t1",
        testName: "happy path",
        workflowId: "wf-1",
        status: "pass",
        duration: 400,
        failedStep: null,
        failedStepDescription: null,
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

function makeCascadeSnapshot(
  sessionId: string,
  overrides: Partial<CascadeSnapshot> = {},
): CascadeSnapshot {
  return {
    id: uid("cas"),
    sessionId,
    triggeredBy: "Add filter to product list",
    createdAt: new Date().toISOString(),
    documentSnapshots: [],
    artifactSnapshots: [],
    status: "active",
    ...overrides,
  };
}

// ---------- shared test suite ----------

interface Backend {
  name: string;
  // Returns a fresh storage instance and a teardown.
  setup(): Promise<{ storage: IStorage; teardown: () => Promise<void> }>;
  // For backends that survive across constructor boundaries (FileStorage),
  // provides a reopen path that hits disk again. Returns null if the backend
  // is in-memory and reopening is meaningless.
  reopen?(): Promise<IStorage | null>;
}

function fileBackend(): Backend {
  let dataDir: string | null = null;
  return {
    name: "FileStorage",
    async setup() {
      dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "uxb-storage-test-"),
      );
      const storage = new FileStorage(dataDir);
      return {
        storage,
        teardown: async () => {
          if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
        },
      };
    },
    async reopen() {
      if (!dataDir) return null;
      return new FileStorage(dataDir);
    },
  };
}

function memoryBackend(): Backend {
  return {
    name: "MemoryStorage",
    async setup() {
      const storage = new MemoryStorage();
      return { storage, teardown: async () => {} };
    },
    // Memory storage cannot reopen — that's intentional.
    reopen: undefined,
  };
}

const backends: Backend[] = [fileBackend(), memoryBackend()];

for (const backend of backends) {
  describe(backend.name, () => {
    let storage: IStorage;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await backend.setup();
      storage = ctx.storage;
      teardown = ctx.teardown;
    });

    afterEach(async () => {
      await teardown();
    });

    // ---------- sessions ----------

    describe("sessions", () => {
      it("creates and retrieves a session", async () => {
        const session = makeSession({ title: "My Product" });
        const created = await storage.createSession(session);
        expect(created).toEqual(session);

        const fetched = await storage.getSession(session.id);
        expect(fetched).toEqual(session);
      });

      it("returns null for missing session", async () => {
        const result = await storage.getSession("does-not-exist");
        expect(result).toBeNull();
      });

      it("updates a session and bumps updatedAt", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const before = session.updatedAt;

        // small delay to ensure updatedAt actually changes
        await new Promise((r) => setTimeout(r, 5));

        const updated = await storage.updateSession(session.id, {
          title: "Renamed",
        });
        expect(updated.title).toBe("Renamed");
        expect(updated.updatedAt).not.toBe(before);
      });

      it("listSessions returns sessions sorted by updatedAt desc", async () => {
        const a = makeSession({
          id: "a",
          updatedAt: new Date(2020, 0, 1).toISOString(),
        });
        const b = makeSession({
          id: "b",
          updatedAt: new Date(2022, 0, 1).toISOString(),
        });
        const c = makeSession({
          id: "c",
          updatedAt: new Date(2021, 0, 1).toISOString(),
        });
        await storage.createSession(a);
        await storage.createSession(b);
        await storage.createSession(c);

        const list = await storage.listSessions();
        expect(list.map((s) => s.id)).toEqual(["b", "c", "a"]);
      });

      it("deleteSession removes the session", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.deleteSession(session.id);
        const fetched = await storage.getSession(session.id);
        expect(fetched).toBeNull();
      });
    });

    // ---------- phase state ----------

    describe("phase state", () => {
      it("upserts and retrieves phase state", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const state = makePhaseState(session.id);
        await storage.upsertPhaseState(state);
        const got = await storage.getPhaseState(session.id, "phase-1");
        expect(got).toEqual(state);
      });

      it("upsert overwrites existing phase state", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.upsertPhaseState(makePhaseState(session.id));
        await storage.upsertPhaseState(
          makePhaseState(session.id, { status: "complete" }),
        );
        const got = await storage.getPhaseState(session.id, "phase-1");
        expect(got?.status).toBe("complete");
      });
    });

    // ---------- documents ----------

    describe("documents", () => {
      it("createDocument bumps version and deactivates prior active", async () => {
        const session = makeSession();
        await storage.createSession(session);

        const v1 = await storage.createDocument(makeDocument(session.id));
        expect(v1.version).toBe(1);
        expect(v1.status).toBe("active");

        const v2 = await storage.createDocument(
          makeDocument(session.id, { content: "v2" }),
        );
        expect(v2.version).toBe(2);
        expect(v2.status).toBe("active");

        const all = await storage.getDocumentsBySession(session.id);
        const v1Refetched = all.find((d) => d.id === v1.id);
        expect(v1Refetched?.status).toBe("inactive");

        const active = await storage.getActiveDocument(
          session.id,
          "project_contract",
        );
        expect(active?.id).toBe(v2.id);
      });

      it("different document types don't interfere", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const contract = await storage.createDocument(
          makeDocument(session.id, { type: "project_contract" }),
        );
        const workflow = await storage.createDocument(
          makeDocument(session.id, { type: "workflow_map" }),
        );
        expect(contract.status).toBe("active");
        expect(workflow.status).toBe("active");
      });

      it("updateDocument requires sessionId in updates", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const doc = await storage.createDocument(makeDocument(session.id));
        await expect(
          storage.updateDocument(doc.id, { content: "edited" }),
        ).rejects.toThrow(/sessionId/);
      });

      it("updateDocument modifies content and lastModifiedAt", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const doc = await storage.createDocument(makeDocument(session.id));
        await new Promise((r) => setTimeout(r, 5));
        const updated = await storage.updateDocument(doc.id, {
          sessionId: session.id,
          content: "edited",
        });
        expect(updated.content).toBe("edited");
        expect(updated.lastModifiedAt).not.toBe(doc.lastModifiedAt);
      });

      it("deactivateDocuments flips all active of a type", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.createDocument(
          makeDocument(session.id, { type: "test_suite" }),
        );
        await storage.deactivateDocuments(session.id, "test_suite");
        const active = await storage.getActiveDocument(session.id, "test_suite");
        expect(active).toBeNull();
      });
    });

    // ---------- artifacts ----------

    describe("artifacts", () => {
      it("create → update through generating → active → inactive", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const artifact = await storage.createArtifact(makeArtifact(session.id));
        expect(artifact.status).toBe("generating");

        const a1 = await storage.updateArtifact(artifact.id, {
          sessionId: session.id,
          status: "active",
        });
        expect(a1.status).toBe("active");

        const active = await storage.getActiveArtifact(
          session.id,
          artifact.filename,
        );
        expect(active?.id).toBe(artifact.id);

        const a2 = await storage.updateArtifact(artifact.id, {
          sessionId: session.id,
          status: "inactive",
        });
        expect(a2.status).toBe("inactive");

        const stillActive = await storage.getActiveArtifact(
          session.id,
          artifact.filename,
        );
        expect(stillActive).toBeNull();
      });

      it("getArtifactsBySession returns all artifacts", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.createArtifact(
          makeArtifact(session.id, { filename: "home.html" }),
        );
        await storage.createArtifact(
          makeArtifact(session.id, { filename: "list.html" }),
        );
        const all = await storage.getArtifactsBySession(session.id);
        expect(all).toHaveLength(2);
      });
    });

    // ---------- chat messages ----------

    describe("chat", () => {
      it("addMessage and getMessagesByPhase", async () => {
        const session = makeSession();
        await storage.createSession(session);
        for (let i = 0; i < 5; i++) {
          await storage.addMessage(
            makeMessage(session.id, {
              content: `msg ${i}`,
              createdAt: new Date(Date.now() + i * 10).toISOString(),
            }),
          );
        }
        const list = await storage.getMessagesByPhase(session.id, "phase-1");
        expect(list).toHaveLength(5);
        expect(list[0].content).toBe("msg 0");
        expect(list[4].content).toBe("msg 4");
      });

      it("getMessagesByPhase filters by phase", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.addMessage(makeMessage(session.id, { phaseId: "phase-1" }));
        await storage.addMessage(makeMessage(session.id, { phaseId: "phase-2" }));
        const phase1 = await storage.getMessagesByPhase(session.id, "phase-1");
        const phase2 = await storage.getMessagesByPhase(session.id, "phase-2");
        expect(phase1).toHaveLength(1);
        expect(phase2).toHaveLength(1);
      });

      it("updateMessage sets stale flag", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const msg = await storage.addMessage(makeMessage(session.id));
        const updated = await storage.updateMessage(msg.id, {
          sessionId: session.id,
          metadata: { ...msg.metadata, stale: true },
        });
        expect(updated.metadata.stale).toBe(true);
      });
    });

    // ---------- operation progress ----------

    describe("operation progress", () => {
      it("upsert and retrieve", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const progress = makeOperationProgress(session.id);
        await storage.upsertOperationProgress(progress);
        const got = await storage.getOperationProgress(session.id, "op-1-0");
        expect(got?.status).toBe("in_progress");
      });

      it("upsert overwrites existing progress for the same op", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.upsertOperationProgress(makeOperationProgress(session.id));
        await storage.upsertOperationProgress(
          makeOperationProgress(session.id, {
            status: "complete",
            completedAt: new Date().toISOString(),
          }),
        );
        const got = await storage.getOperationProgress(session.id, "op-1-0");
        expect(got?.status).toBe("complete");
      });

      it("getOperationsBySession returns all operations", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.upsertOperationProgress(
          makeOperationProgress(session.id, { operationId: "op-1-0" }),
        );
        await storage.upsertOperationProgress(
          makeOperationProgress(session.id, { operationId: "op-1-1" }),
        );
        const all = await storage.getOperationsBySession(session.id);
        expect(all).toHaveLength(2);
      });
    });

    // ---------- checkpoints ----------

    describe("checkpoints", () => {
      it("create, getByNumber, getLatest", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.createCheckpoint(makeCheckpoint(session.id, 1));
        await storage.createCheckpoint(makeCheckpoint(session.id, 3));
        await storage.createCheckpoint(makeCheckpoint(session.id, 2));

        const cp2 = await storage.getCheckpointByNumber(session.id, 2);
        expect(cp2?.number).toBe(2);

        const latest = await storage.getLatestCheckpoint(session.id);
        expect(latest?.number).toBe(3);
      });

      it("snapshots survive a full roundtrip", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const cp = await storage.createCheckpoint(makeCheckpoint(session.id, 1));
        const got = await storage.getCheckpointByNumber(session.id, 1);
        expect(got?.documentSnapshots).toEqual(cp.documentSnapshots);
        expect(got?.artifactSnapshots).toEqual(cp.artifactSnapshots);
      });
    });

    // ---------- conversation summaries ----------

    describe("conversation summaries", () => {
      it("upsert and retrieve", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.upsertConversationSummary(makeSummary(session.id));
        const got = await storage.getConversationSummary(session.id, "phase-1");
        expect(got?.summary).toContain("recipe");
      });
    });

    // ---------- pending messages ----------

    describe("pending messages", () => {
      it("create, list, update", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const msg = await storage.createPendingMessage(
          makePendingMessage(session.id),
        );
        const list = await storage.getPendingMessages(session.id);
        expect(list).toHaveLength(1);

        const updated = await storage.updatePendingMessage(msg.id, {
          sessionId: session.id,
          status: "applied",
        });
        expect(updated.status).toBe("applied");
      });
    });

    // ---------- test results ----------

    describe("test results", () => {
      it("save and retrieve latest", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.saveTestRunResult(
          makeTestRun(session.id, {
            runAt: new Date(Date.now() - 5000).toISOString(),
          }),
        );
        const newer = await storage.saveTestRunResult(
          makeTestRun(session.id, {
            runAt: new Date().toISOString(),
            passed: 5,
          }),
        );
        const latest = await storage.getLatestTestRunResult(session.id);
        expect(latest?.id).toBe(newer.id);
      });
    });

    // ---------- cascade snapshots ----------

    describe("cascade snapshots", () => {
      it("create, getLatest, update status", async () => {
        const session = makeSession();
        await storage.createSession(session);
        await storage.createCascadeSnapshot(
          makeCascadeSnapshot(session.id, {
            createdAt: new Date(Date.now() - 5000).toISOString(),
          }),
        );
        const newer = await storage.createCascadeSnapshot(
          makeCascadeSnapshot(session.id),
        );

        const latest = await storage.getLatestCascadeSnapshot(session.id);
        expect(latest?.id).toBe(newer.id);

        const updated = await storage.updateCascadeSnapshot(newer.id, {
          sessionId: session.id,
          status: "applied",
        });
        expect(updated.status).toBe("applied");
      });
    });

    // ---------- isolation ----------

    describe("isolation", () => {
      it("data from one session is invisible from another", async () => {
        const a = makeSession({ id: "iso-a" });
        const b = makeSession({ id: "iso-b" });
        await storage.createSession(a);
        await storage.createSession(b);
        await storage.createDocument(makeDocument(a.id));
        const bDocs = await storage.getDocumentsBySession(b.id);
        expect(bDocs).toHaveLength(0);
      });

      it("returned objects are decoupled from internal state", async () => {
        const session = makeSession();
        await storage.createSession(session);
        const got1 = await storage.getSession(session.id);
        if (got1) got1.title = "MUTATED";
        const got2 = await storage.getSession(session.id);
        expect(got2?.title).not.toBe("MUTATED");
      });
    });

    // ---------- persistence (file backend only) ----------

    if (backend.reopen) {
      describe("persistence", () => {
        it("survives a fresh storage instance against the same dataDir", async () => {
          const session = makeSession({ title: "Persisted" });
          await storage.createSession(session);
          await storage.createDocument(makeDocument(session.id));
          await storage.addMessage(makeMessage(session.id));

          const reopened = await backend.reopen!();
          expect(reopened).not.toBeNull();
          if (!reopened) return;

          const got = await reopened.getSession(session.id);
          expect(got?.title).toBe("Persisted");

          const docs = await reopened.getDocumentsBySession(session.id);
          expect(docs).toHaveLength(1);

          const messages = await reopened.getMessagesByPhase(
            session.id,
            "phase-1",
          );
          expect(messages).toHaveLength(1);
        });
      });
    }
  });
}
