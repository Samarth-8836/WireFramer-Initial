import { v4 as uuidv4 } from "uuid";

import type { SSEWriter } from "@core/operation-executor";
import type { IStorage } from "@core/storage/interface";
import type { Session } from "@core/types";

import { routeMessage } from "./operation-router";

// Session Manager is the central coordinator. Every user action — create
// session, send message, complete phase — enters through one of its
// methods. It owns three things:
//
//   1. Session lifecycle state. Creates sessions, phase states, and the
//      initial checkpoint; delegates to the phase state machine on
//      transitions (Sprint 5 wires that in).
//
//   2. Chat blocking / per-session mutex. While an operation is running
//      for a session, further user input is rejected with a "please wait"
//      error. Implemented as an acquire-or-reject flag, not a queue.
//
//   3. Routing. Based on the current phase + session state, it picks the
//      right handler method. The actual LLM work happens in injected
//      handlers, not in the session manager itself — this keeps the
//      coordinator pure and testable now (Sprint 4), while allowing
//      Sprint 5 to drop in real op implementations without changing the
//      coordinator.
//
// What it deliberately does NOT do:
//   - Call the LLM. That's the handlers' job (which in turn use the
//     Operation Executor + Context Builder + Prompt Registry).
//   - Decide prompt content. That's the Prompt Registry + Context Builder.
//   - Own the dependency graph for auto-generation. The graph topology
//     lives in `auto-generation-graph.ts` and the DAG executor in
//     `dependency-graph.ts`. Session Manager will use them when Sprint 6
//     wires up the Phase 2 auto-gen chain.

export interface Phase1Handlers {
  // Fire-and-forget title generation. Invoked during createSession in
  // parallel with the main first-message response so the user sees a
  // title appear shortly after they hit send.
  generateTitle(sessionId: string, firstMessage: string): Promise<void>;
  // The main Phase 1 first-message handler. Runs Op 1.1 (goal expansion)
  // + Op 1.2 (contract generation) via the two-AI pattern and streams
  // the result through the SSE writer.
  handleFirstMessage(
    sessionId: string,
    message: string,
    sse: SSEWriter,
  ): Promise<void>;
  // Subsequent Phase 1 messages. Runs Op 1.2 (iteration) to update the
  // existing Project Contract.
  handleIteration(
    sessionId: string,
    message: string,
    sse: SSEWriter,
  ): Promise<void>;
  // Phase 1 completion: validation (Op 1.3), phase transition on PASS,
  // Phase 2 bootstrap. Sprint 5 wires this.
  completePhase(sessionId: string, sse: SSEWriter): Promise<void>;
}

export interface Phase2Handlers {
  // Phase 2 conversational — Op 2.7a with drift detection and cascade
  // application as needed. Optional screenRef lets the user pin a screen
  // in the UI which is then included in the context (Sprint 3).
  handleMessage(
    sessionId: string,
    message: string,
    screenRef: string | null,
    sse: SSEWriter,
  ): Promise<void>;
  // Phase 2 auto-generation chain (Ops 2.1a-2.5e). Kicked off by
  // SessionManager.completePhase when Phase 1 validates PASS, or via the
  // /api/phase2/start route for manual retriggering.
  runAutoGeneration(sessionId: string, sse: SSEWriter): Promise<void>;
  // Phase 2 completion: export artifacts + Op 2.9 validation pass.
  completePhase(sessionId: string, sse: SSEWriter): Promise<void>;
}

export interface SessionHandlers {
  phase1: Phase1Handlers;
  phase2: Phase2Handlers;
}

export class SessionManager {
  private readonly chatBlocked = new Map<string, boolean>();

  constructor(
    private readonly storage: IStorage,
    private readonly handlers: SessionHandlers,
  ) {}

  // Create a brand-new session. Sets up the session record, phase-1 state,
  // and the initial checkpoint; then fires Op 1.0 (title, fire-and-forget)
  // in parallel with Op 1.1 (goal expansion, the main streamed response).
  async createSession(
    firstMessage: string,
    sse: SSEWriter,
  ): Promise<Session> {
    const sessionId = uuidv4();
    const now = new Date().toISOString();

    const session = await this.storage.createSession({
      id: sessionId,
      title: "New Session",
      currentPhaseId: "phase-1",
      createdAt: now,
      updatedAt: now,
      status: "active",
    });

    await this.storage.upsertPhaseState({
      sessionId,
      phaseId: "phase-1",
      status: "active",
      enteredAt: now,
      completedAt: null,
      suspendedAt: null,
    });

    await this.storage.createCheckpoint({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-1",
      number: 1,
      createdAt: now,
      documentSnapshots: [],
      artifactSnapshots: [],
    });

    // Tell the client the new session id BEFORE handleFirstMessage runs —
    // that handler ends with sse.sendComplete() which closes the stream,
    // and any meta emitted after a close is silently dropped. Emitting
    // here is what the client's `session_info` handler uses to set
    // activeSessionId, so follow-up messages route to the right session.
    sse.sendMeta({ event: "session_info", sessionId });

    // Hold the lock for the duration of the first-message handler so a
    // racing follow-up message gets rejected rather than interleaving.
    if (!this.tryAcquireLock(sessionId)) {
      // Should never happen — we just created the session and it can't
      // already be locked. Defensive branch.
      sse.sendError("Session is already processing an operation.", true);
      sse.close();
      return session;
    }

    try {
      // Title generation runs alongside the main response. We don't
      // await it. A title failure shouldn't crash the session — we log
      // and continue with the default title.
      void this.handlers.phase1
        .generateTitle(sessionId, firstMessage)
        .catch((err) => {
          console.warn(
            `[session-manager] title generation failed for ${sessionId}:`,
            err,
          );
        });

      await this.handlers.phase1.handleFirstMessage(
        sessionId,
        firstMessage,
        sse,
      );
    } finally {
      this.releaseLock(sessionId);
    }

    return session;
  }

  // Handle a user message in an existing session. Locks the session for
  // the duration of the operation; rejects overlapping messages with a
  // "please wait" error.
  async handleMessage(
    sessionId: string,
    message: string,
    screenRef: string | null,
    sse: SSEWriter,
  ): Promise<void> {
    if (!this.tryAcquireLock(sessionId)) {
      sse.sendError("Please wait for the current operation to complete.");
      sse.close();
      return;
    }

    try {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        sse.sendError(`Session ${sessionId} not found.`, true);
        sse.close();
        return;
      }

      const phase = await this.storage.getPhaseState(
        sessionId,
        session.currentPhaseId,
      );
      if (!phase || phase.status !== "active") {
        sse.sendError(
          `Phase ${session.currentPhaseId} is not active (current status: ${phase?.status ?? "none"}).`,
        );
        sse.close();
        return;
      }

      if (session.currentPhaseId === "phase-1") {
        const docs = await this.storage.getDocumentsBySession(sessionId);
        const hasExistingDocuments = docs.length > 0;
        const routed = routeMessage({
          phaseId: "phase-1",
          hasExistingDocuments,
        });
        if (routed === "op-1-1") {
          await this.handlers.phase1.handleFirstMessage(
            sessionId,
            message,
            sse,
          );
        } else {
          await this.handlers.phase1.handleIteration(sessionId, message, sse);
        }
      } else {
        await this.handlers.phase2.handleMessage(
          sessionId,
          message,
          screenRef,
          sse,
        );
      }
    } finally {
      this.releaseLock(sessionId);
    }
  }

  // Complete the current phase. Delegates to the phase-specific completion
  // handler, which owns the validation + transition + bootstrap flow.
  //
  // On a Phase 1 PASS this method chains straight into Phase 2 auto-gen
  // on the same SSE stream — there's no separate UI trigger for Phase 2,
  // so completing Phase 1 implicitly starts the generation chain.
  async completePhase(sessionId: string, sse: SSEWriter): Promise<void> {
    if (!this.tryAcquireLock(sessionId)) {
      sse.sendError("Please wait for the current operation to complete.");
      sse.close();
      return;
    }

    try {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        sse.sendError(`Session ${sessionId} not found.`, true);
        sse.close();
        return;
      }

      if (session.currentPhaseId === "phase-1") {
        await this.handlers.phase1.completePhase(sessionId, sse);

        // On PASS, phase-1's status is now "complete". Chain straight into
        // Phase 2 auto-gen so the user doesn't have to click anything else.
        // On FAIL, phase-1 stays "active" — close the stream here.
        const phase1State = await this.storage.getPhaseState(
          sessionId,
          "phase-1",
        );
        if (phase1State?.status === "complete") {
          // runAutoGeneration owns the sendComplete at the end of its chain.
          await this.handlers.phase2.runAutoGeneration(sessionId, sse);
        } else {
          sse.sendComplete({ validation: "FAIL" });
        }
      } else {
        await this.handlers.phase2.completePhase(sessionId, sse);
      }
    } finally {
      this.releaseLock(sessionId);
    }
  }

  isBlocked(sessionId: string): boolean {
    return this.chatBlocked.get(sessionId) === true;
  }

  // Atomic acquire-or-reject. Returns true if the caller now holds the
  // lock; false if someone else already does. Because JavaScript is
  // single-threaded the check-and-set is atomic with respect to other
  // async callers, as long as nothing awaits between the check and the
  // set (which this method does not).
  private tryAcquireLock(sessionId: string): boolean {
    if (this.chatBlocked.get(sessionId) === true) return false;
    this.chatBlocked.set(sessionId, true);
    return true;
  }

  private releaseLock(sessionId: string): void {
    this.chatBlocked.set(sessionId, false);
  }
}
