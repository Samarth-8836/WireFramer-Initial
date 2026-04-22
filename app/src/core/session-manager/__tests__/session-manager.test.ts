import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SSEWriter } from "@core/operation-executor";
import { MemoryStorage } from "@core/storage";

import {
  SessionManager,
  type Phase1Handlers,
  type Phase2Handlers,
  type SessionHandlers,
} from "../session-manager";

// Deterministic handler stubs that record every call and optionally delay
// so tests can race against them.
interface Phase1Recorder extends Phase1Handlers {
  calls: Array<{ method: string; args: unknown[] }>;
  delayMs: number;
  throwOnTitle: boolean;
}

function makePhase1Handlers(): Phase1Recorder {
  const calls: Phase1Recorder["calls"] = [];
  const rec = {
    calls,
    delayMs: 0,
    throwOnTitle: false,
    async generateTitle(sessionId: string, firstMessage: string) {
      calls.push({ method: "generateTitle", args: [sessionId, firstMessage] });
      if (rec.throwOnTitle) throw new Error("title boom");
    },
    async handleFirstMessage(sessionId: string, message: string) {
      calls.push({ method: "handleFirstMessage", args: [sessionId, message] });
      if (rec.delayMs > 0) {
        await new Promise((r) => setTimeout(r, rec.delayMs));
      }
    },
    async handleIteration(sessionId: string, message: string) {
      calls.push({ method: "handleIteration", args: [sessionId, message] });
    },
    async completePhase(sessionId: string) {
      calls.push({ method: "completePhase-1", args: [sessionId] });
    },
  };
  return rec;
}

interface Phase2Recorder extends Phase2Handlers {
  calls: Array<{ method: string; args: unknown[] }>;
}

function makePhase2Handlers(): Phase2Recorder {
  const calls: Phase2Recorder["calls"] = [];
  return {
    calls,
    async handleMessage(sessionId, message, screenRef) {
      calls.push({
        method: "handleMessage",
        args: [sessionId, message, screenRef],
      });
    },
    async runAutoGeneration(sessionId) {
      calls.push({ method: "runAutoGeneration", args: [sessionId] });
    },
    async advanceStage(sessionId) {
      calls.push({ method: "advanceStage", args: [sessionId] });
    },
    async completePhase(sessionId) {
      calls.push({ method: "completePhase-2", args: [sessionId] });
    },
  };
}

interface Harness {
  storage: MemoryStorage;
  phase1: Phase1Recorder;
  phase2: Phase2Recorder;
  manager: SessionManager;
}

function makeHarness(): Harness {
  const storage = new MemoryStorage();
  const phase1 = makePhase1Handlers();
  const phase2 = makePhase2Handlers();
  const handlers: SessionHandlers = { phase1, phase2 };
  const manager = new SessionManager(storage, handlers);
  return { storage, phase1, phase2, manager };
}

function freshSSE(): SSEWriter {
  const w = new SSEWriter();
  w.createStream();
  return w;
}

describe("SessionManager.createSession", () => {
  it("creates the session record, phase-1 state, and checkpoint 1", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("build a task tracker", freshSSE());

    const stored = await h.storage.getSession(session.id);
    expect(stored).not.toBeNull();
    expect(stored!.currentPhaseId).toBe("phase-1");
    expect(stored!.status).toBe("active");

    const phase = await h.storage.getPhaseState(session.id, "phase-1");
    expect(phase).not.toBeNull();
    expect(phase!.status).toBe("active");
    expect(phase!.enteredAt).not.toBeNull();

    const checkpoint = await h.storage.getCheckpointByNumber(session.id, 1);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.number).toBe(1);
    expect(checkpoint!.documentSnapshots).toEqual([]);
    expect(checkpoint!.artifactSnapshots).toEqual([]);
  });

  it("fires both title generation and handleFirstMessage", async () => {
    const h = makeHarness();
    await h.manager.createSession("hello there", freshSSE());

    // Order of calls: handleFirstMessage is awaited, generateTitle is
    // fire-and-forget started before it. Both must have been called.
    const methods = h.phase1.calls.map((c) => c.method);
    expect(methods).toContain("generateTitle");
    expect(methods).toContain("handleFirstMessage");
  });

  it("does not throw when title generation rejects (title is best-effort)", async () => {
    const h = makeHarness();
    h.phase1.throwOnTitle = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      h.manager.createSession("hi", freshSSE()),
    ).resolves.toBeDefined();

    // Give the fire-and-forget rejection a tick to propagate through the
    // catch handler.
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("releases the chat lock after createSession completes", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    expect(h.manager.isBlocked(session.id)).toBe(false);
  });

  // Regression: session_info must be emitted BEFORE the handler that
  // sendComplete's the stream. Earlier the chat route was emitting
  // session_info *after* createSession returned, by which point the
  // stream was already closed — the client never got the sessionId and
  // follow-up messages spawned new sessions.
  it("emits a session_info meta event synchronously after creating the session record", async () => {
    const h = makeHarness();
    const sse = new SSEWriter();
    sse.createStream();
    const emitted: Array<{ type: string; data: unknown }> = [];
    const originalSend = sse.send.bind(sse);
    sse.send = ((event: Parameters<typeof sse.send>[0]) => {
      emitted.push({ type: event.type, data: event.data });
      originalSend(event);
    }) as typeof sse.send;

    const session = await h.manager.createSession("hi", sse);

    const metaEvents = emitted.filter((e) => e.type === "meta");
    const sessionInfo = metaEvents.find(
      (e) => (e.data as { event?: string }).event === "session_info",
    );
    expect(sessionInfo).toBeDefined();
    expect((sessionInfo!.data as { sessionId: string }).sessionId).toBe(
      session.id,
    );
  });
});

describe("SessionManager.handleMessage — routing", () => {
  async function bootstrap(h: Harness): Promise<string> {
    const session = await h.manager.createSession("first", freshSSE());
    // Reset recorded calls so we can assert just what handleMessage does.
    h.phase1.calls.length = 0;
    h.phase2.calls.length = 0;
    return session.id;
  }

  it("routes Phase 1 follow-ups to handleIteration when documents already exist", async () => {
    const h = makeHarness();
    const sessionId = await bootstrap(h);

    // Fake an existing project_contract so the router picks iteration.
    await h.storage.createDocument({
      id: "doc-1",
      sessionId,
      phaseId: "phase-1",
      type: "project_contract",
      content: "CONTRACT",
      structuredData: "",
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    });

    await h.manager.handleMessage(sessionId, "add a dashboard", null, freshSSE());

    expect(h.phase1.calls.map((c) => c.method)).toEqual(["handleIteration"]);
  });

  it("routes Phase 1 follow-ups to handleFirstMessage when no documents exist yet", async () => {
    const h = makeHarness();
    const sessionId = await bootstrap(h);
    // No document seeded: router should return op-1-1 and we dispatch to
    // handleFirstMessage again (retry of a failed first attempt).
    await h.manager.handleMessage(sessionId, "try again", null, freshSSE());
    expect(h.phase1.calls.map((c) => c.method)).toEqual([
      "handleFirstMessage",
    ]);
  });

  it("routes Phase 2 messages to phase2.handleMessage and passes screenRef through", async () => {
    const h = makeHarness();
    const sessionId = await bootstrap(h);

    // Flip session to Phase 2 + seed a phase-2 active state.
    await h.storage.updateSession(sessionId, { currentPhaseId: "phase-2" });
    await h.storage.upsertPhaseState({
      sessionId,
      phaseId: "phase-2",
      status: "active",
      enteredAt: new Date().toISOString(),
      completedAt: null,
      suspendedAt: null,
    });

    await h.manager.handleMessage(
      sessionId,
      "change the button copy",
      "screen-001",
      freshSSE(),
    );

    expect(h.phase2.calls).toHaveLength(1);
    expect(h.phase2.calls[0].method).toBe("handleMessage");
    expect(h.phase2.calls[0].args).toEqual([
      sessionId,
      "change the button copy",
      "screen-001",
    ]);
  });
});

describe("SessionManager.handleMessage — chat blocking", () => {
  // Patch the SSE writer's close so tests don't hit the real stream lifecycle
  // when we're only checking that an error event was dispatched.
  let sse: SSEWriter;
  let errorCalls: Array<{ error: string; fatal: boolean }>;

  beforeEach(() => {
    sse = new SSEWriter();
    sse.createStream();
    errorCalls = [];
    sse.sendError = (error: string, fatal = false) => {
      errorCalls.push({ error, fatal });
    };
    sse.close = () => {};
  });

  afterEach(() => {
    errorCalls = [];
  });

  it("rejects a second concurrent handleMessage with a 'please wait' error", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    h.phase1.calls.length = 0;

    // Seed a contract so follow-ups route to iteration, and slow iteration
    // down to 50ms so the second call races with the first.
    await h.storage.createDocument({
      id: "doc-1",
      sessionId: session.id,
      phaseId: "phase-1",
      type: "project_contract",
      content: "CONTRACT",
      structuredData: "",
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    });

    // Monkey-patch handleIteration to delay so the first call is in-flight
    // when the second arrives.
    const originalIter = h.phase1.handleIteration.bind(h.phase1);
    h.phase1.handleIteration = async (
      sid: string,
      msg: string,
      sseArg,
    ) => {
      await new Promise((r) => setTimeout(r, 50));
      return originalIter(sid, msg, sseArg);
    };

    const first = h.manager.handleMessage(session.id, "first", null, freshSSE());
    // Nudge the microtask queue so first acquires the lock before second.
    await new Promise((r) => setTimeout(r, 5));
    const second = h.manager.handleMessage(session.id, "second", null, sse);

    await Promise.all([first, second]);

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].error).toMatch(/Please wait/);
  });

  it("releases the lock after a handler throws, so the next message can proceed", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    h.phase1.calls.length = 0;

    h.phase1.handleFirstMessage = async () => {
      throw new Error("handler exploded");
    };

    await expect(
      h.manager.handleMessage(session.id, "retry", null, freshSSE()),
    ).rejects.toThrow(/handler exploded/);

    expect(h.manager.isBlocked(session.id)).toBe(false);
  });
});

describe("SessionManager.handleMessage — validation", () => {
  it("sends a fatal error when the session does not exist", async () => {
    const h = makeHarness();
    const sse = new SSEWriter();
    sse.createStream();
    const errors: Array<{ error: string; fatal: boolean }> = [];
    sse.sendError = (e, fatal = false) => {
      errors.push({ error: e, fatal });
    };
    sse.close = () => {};

    await h.manager.handleMessage("no-such-session", "hi", null, sse);
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(true);
    expect(errors[0].error).toMatch(/not found/);
  });

  it("rejects messages when the phase is suspended", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    h.phase1.calls.length = 0;
    await h.storage.upsertPhaseState({
      sessionId: session.id,
      phaseId: "phase-1",
      status: "suspended",
      enteredAt: new Date().toISOString(),
      completedAt: null,
      suspendedAt: new Date().toISOString(),
    });

    const sse = new SSEWriter();
    sse.createStream();
    const errors: string[] = [];
    sse.sendError = (e) => {
      errors.push(e);
    };
    sse.close = () => {};

    await h.manager.handleMessage(session.id, "hi", null, sse);
    expect(errors[0]).toMatch(/not active/);
    // Handler must NOT have been called.
    expect(h.phase1.calls).toHaveLength(0);
  });
});

describe("SessionManager.completePhase", () => {
  it("delegates to phase1.completePhase when session is in phase-1", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    h.phase1.calls.length = 0;
    await h.manager.completePhase(session.id, freshSSE());
    expect(h.phase1.calls.map((c) => c.method)).toEqual([
      "completePhase-1",
    ]);
  });

  it("delegates to phase2.completePhase when session is in phase-2", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    await h.storage.updateSession(session.id, { currentPhaseId: "phase-2" });
    await h.manager.completePhase(session.id, freshSSE());
    expect(h.phase2.calls.map((c) => c.method)).toEqual([
      "completePhase-2",
    ]);
  });

  // Regression: after Phase 1 completion PASSes, SessionManager must
  // chain straight into phase-2 auto-gen on the same SSE stream — there
  // is no separate UI trigger.
  it("chains into phase2.runAutoGeneration when phase-1 transitions to complete", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());

    // Simulate a PASS: phase1.completePhase would normally transition
    // phase-1 to complete. Our recorder doesn't actually call
    // transitionPhase, so manually flip the state after the recorder
    // returns — emulated by monkey-patching the recorder.
    h.phase1.completePhase = async (sid: string) => {
      h.phase1.calls.push({ method: "completePhase-1", args: [sid] });
      await h.storage.upsertPhaseState({
        sessionId: sid,
        phaseId: "phase-1",
        status: "complete",
        enteredAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        suspendedAt: null,
      });
    };

    h.phase1.calls.length = 0;
    await h.manager.completePhase(session.id, freshSSE());

    expect(h.phase1.calls.map((c) => c.method)).toEqual(["completePhase-1"]);
    expect(h.phase2.calls.map((c) => c.method)).toEqual(["runAutoGeneration"]);
  });

  it("does NOT chain to phase-2 when phase-1 completion returned FAIL", async () => {
    const h = makeHarness();
    const session = await h.manager.createSession("hi", freshSSE());
    // Default recorder completePhase does nothing — phase-1 stays "active".
    h.phase1.calls.length = 0;
    await h.manager.completePhase(session.id, freshSSE());

    expect(h.phase1.calls.map((c) => c.method)).toEqual(["completePhase-1"]);
    // phase-2 handler never invoked.
    expect(h.phase2.calls).toEqual([]);
  });
});
