import { v4 as uuidv4 } from "uuid";

import type { ContextBuilder } from "@core/context-builder";
import type {
  OperationExecutor,
  SSEWriter,
} from "@core/operation-executor";
import {
  executeGoalExpansion,
  executeIteration,
  generateTitle,
  validatePhase1,
} from "@core/operations/phase1";
import type { IPromptRegistry } from "@core/prompts";
import type { IStorage } from "@core/storage/interface";
import type { TwoAIResult } from "@core/operation-executor";
import type { ValidationResultData } from "@core/operation-executor";

import type { Phase1Handlers } from "./session-manager";
import { transitionPhase } from "./phase-state-machine";

// Concrete Phase 1 handlers. Wires Sprint 2 (Operation Executor) + Sprint
// 3 (Context Builder + Prompt Registry + Summarizer) + Sprint 5 ops to
// the Phase1Handlers interface the Session Manager expects. Kept separate
// from Session Manager so Sprint 4 can still be tested with recorder
// stubs and nothing in this file leaks back into the coordinator.

export interface Phase1HandlerDeps {
  storage: IStorage;
  executor: OperationExecutor;
  contextBuilder: ContextBuilder;
  promptRegistry: IPromptRegistry;
}

export class Phase1HandlersImpl implements Phase1Handlers {
  constructor(private readonly deps: Phase1HandlerDeps) {}

  // Fire-and-forget: generate a short title and write it onto the
  // session record. Session Manager calls this in parallel with
  // handleFirstMessage, so a failure here should never propagate back to
  // the user — caller is already wrapped in a `.catch(console.warn)`.
  async generateTitle(sessionId: string, firstMessage: string): Promise<void> {
    const title = await generateTitle(
      this.deps.executor,
      this.deps.promptRegistry,
      firstMessage,
      sessionId,
    );
    await this.deps.storage.updateSession(sessionId, { title });
  }

  async handleFirstMessage(
    sessionId: string,
    message: string,
    sse: SSEWriter,
  ): Promise<void> {
    await this.persistUserMessage(sessionId, message, "op-1-1");

    try {
      const result = await executeGoalExpansion(
        this.deps.executor,
        this.deps.contextBuilder,
        message,
        sse,
        sessionId,
      );
      await this.persistAssistantResponseAndDocument(
        sessionId,
        "op-1-1",
        result,
        sse,
      );
      sse.sendComplete();
    } catch (err) {
      this.emitFatalError(sse, err);
    }
  }

  async handleIteration(
    sessionId: string,
    message: string,
    sse: SSEWriter,
  ): Promise<void> {
    await this.persistUserMessage(sessionId, message, "op-1-2");

    try {
      const result = await executeIteration(
        this.deps.executor,
        this.deps.contextBuilder,
        message,
        sse,
        sessionId,
      );
      await this.persistAssistantResponseAndDocument(
        sessionId,
        "op-1-2",
        result,
        sse,
      );
      sse.sendComplete();
    } catch (err) {
      this.emitFatalError(sse, err);
    }
  }

  // Runs op-1-3 validation. On PASS, transitions phase-1 -> completing
  // -> complete. On FAIL, keeps phase-1 active and surfaces the issues
  // as a system_notification chat message so the user can fix and retry.
  async completePhase(sessionId: string, sse: SSEWriter): Promise<void> {
    sse.sendProgress({
      operationId: "op-1-3",
      status: "in_progress",
      detail: "Validating Project Contract",
    });

    let result: ValidationResultData;
    try {
      result = await validatePhase1(
        this.deps.executor,
        this.deps.contextBuilder,
        sessionId,
      );
    } catch (err) {
      this.emitFatalError(sse, err);
      return;
    }

    const validationMessage = this.formatValidationMessage(result);
    await this.deps.storage.addMessage({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-1",
      role: "system",
      type: "validation_result",
      content: validationMessage,
      metadata: {
        screenReference: null,
        generationContext: null,
        operationId: "op-1-3",
        stale: false,
      },
      createdAt: new Date().toISOString(),
    });

    if (result.status === "PASS") {
      await transitionPhase(this.deps.storage, sessionId, "phase-1", "completing");
      await transitionPhase(this.deps.storage, sessionId, "phase-1", "complete");
      sse.send({
        type: "phase",
        data: { phaseId: "phase-1", status: "complete" },
      });
    } else {
      sse.send({
        type: "phase",
        data: { phaseId: "phase-1", status: "active" },
      });
    }

    sse.send({
      type: "test_results",
      data: {
        status: result.status,
        issues: result.issues,
        suggestions: result.suggestions,
      },
    });

    // Don't sendComplete here — the SessionManager's completePhase will
    // decide what comes next. On PASS it chains into phase-2 auto-gen
    // (which sendComplete's itself); on FAIL it closes the stream.
  }

  // ---------- internals ----------

  private async persistUserMessage(
    sessionId: string,
    content: string,
    operationId: "op-1-1" | "op-1-2",
  ): Promise<void> {
    await this.deps.storage.addMessage({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-1",
      role: "user",
      type: "chat",
      content,
      metadata: {
        screenReference: null,
        generationContext: null,
        operationId,
        stale: false,
      },
      createdAt: new Date().toISOString(),
    });
  }

  private async persistAssistantResponseAndDocument(
    sessionId: string,
    operationId: "op-1-1" | "op-1-2",
    result: TwoAIResult,
    sse: SSEWriter,
  ): Promise<void> {
    // If Call A produced no visible prose (the whole response started with
    // <generation_context>), fall back to a sensible default so rehydrating
    // the session from storage doesn't yield a blank bubble. Without this,
    // the user sees streamed text live but an empty bubble after a session
    // switch.
    const persistedContent =
      result.visibleResponse.trim().length > 0
        ? result.visibleResponse
        : result.generatedDocument
          ? "Updated the project contract."
          : "";

    await this.deps.storage.addMessage({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-1",
      role: "assistant",
      type: "chat",
      content: persistedContent,
      metadata: {
        screenReference: null,
        generationContext: result.structuredData
          ? safeStringify(result.structuredData)
          : null,
        operationId,
        stale: false,
      },
      createdAt: new Date().toISOString(),
    });

    if (!result.generatedDocument) {
      // Clarifying question path — no document produced this turn.
      return;
    }

    const doc = await this.deps.storage.createDocument({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-1",
      type: "project_contract",
      content: result.generatedDocument,
      structuredData: result.structuredData
        ? safeStringify(result.structuredData)
        : "",
      // Storage auto-bumps; this value is a placeholder.
      version: 0,
      status: "active",
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    });

    sse.sendDocument({
      type: "project_contract",
      content: doc.content,
      version: doc.version,
    });
  }

  private formatValidationMessage(result: ValidationResultData): string {
    const lines: string[] = [`STATUS: ${result.status}`];
    if (result.issues.length > 0) {
      lines.push("", "Issues:");
      for (const issue of result.issues) lines.push(`- ${issue}`);
    }
    if (result.suggestions.length > 0) {
      lines.push("", "Suggestions:");
      for (const sug of result.suggestions) lines.push(`- ${sug}`);
    }
    return lines.join("\n");
  }

  private emitFatalError(sse: SSEWriter, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    sse.sendError(`Phase 1 operation failed: ${message}`, true);
    sse.close();
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
