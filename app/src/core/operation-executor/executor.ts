import type { Context } from "@mariozechner/pi-ai";
import { stream } from "@mariozechner/pi-ai";

import { getApiKey, resolveModel } from "@core/llm/providers";
import type {
  LLMMessage,
  OperationDefinition,
  OperationResult,
  ParseResult,
  RoleName,
} from "@core/types";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "@lib/constants";

import { buildRetryMessages } from "./retry";
import { TokenTracker, type TokenRecord } from "./token-tracker";

// The Operation Executor is the single place in the system that talks to
// pi-ai. Every AI call — Phase 1 chat, Phase 2 batch generation, drift
// checks, validations, diagnoses — flows through `execute()`.
//
// Responsibilities:
//   1. Resolve role -> concrete pi-ai Model via providers.ts
//   2. Build pi-ai Context (system + messages with timestamps)
//   3. Stream events; accumulate text + usage; forward chunks to onStreamChunk
//   4. Run the op's parser on the accumulated text
//   5. On parse failure: build retry messages and try again, up to maxRetries
//   6. On transport failure: surface the error message into the result
//   7. Track per-session tokens + cost via TokenTracker
//
// What it deliberately does NOT do:
//   - Decide which prompt to use (that's the job of the prompt registry)
//   - Persist the result (storage layer)
//   - Coordinate multi-call patterns (that's two-ai-pattern.ts)
//   - Decide retry strategy beyond the per-op maxRetries (that's session-manager)

export interface ExecutorOptions {
  // Optional shared TokenTracker — pass one if you want session-wide
  // accumulation across many execute() calls. Otherwise the executor
  // keeps its own per-instance tracker.
  tokenTracker?: TokenTracker;
}

export interface ExecuteOptions {
  // Session id used for token attribution. Optional — passing nothing means
  // the call still works but isn't recorded against any session.
  sessionId?: string;
  // Per-call AbortSignal. Cancels the in-flight stream.
  signal?: AbortSignal;
}

interface StreamCallResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorMessage: string | null;
}

export class OperationExecutor {
  private readonly tokenTracker: TokenTracker;

  constructor(options: ExecutorOptions = {}) {
    this.tokenTracker = options.tokenTracker ?? new TokenTracker();
  }

  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  async execute<T>(
    definition: OperationDefinition<T>,
    options: ExecuteOptions = {},
  ): Promise<OperationResult<T>> {
    const startTime = Date.now();
    const role: RoleName = definition.role ?? "reasoning";
    const resolved = resolveModel(role);
    const apiKey = getApiKey(resolved.provider);

    // Per-op timeout. We honor it via a private AbortController that we
    // combine with the caller's signal (if any) below.
    const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(
      () => timeoutController.abort(new Error("Operation timed out")),
      timeoutMs,
    );

    // Combine caller signal with our timeout signal.
    const signal = options.signal
      ? mergeSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;

    const maxAttempts = 1 + (definition.maxRetries ?? DEFAULT_MAX_RETRIES);
    let currentMessages = [...definition.messages];
    let lastError: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const context: Context = {
          systemPrompt: definition.systemPrompt,
          messages: currentMessages.map(toPiAiMessage),
        };

        const callResult = await this.streamCall({
          model: resolved.model,
          context,
          apiKey,
          signal,
          onChunk: definition.onStreamChunk,
        });

        totalInputTokens += callResult.inputTokens;
        totalOutputTokens += callResult.outputTokens;
        totalCostUsd += callResult.costUsd;

        if (callResult.errorMessage !== null) {
          // Transport-level error from pi-ai. Don't retry the parser loop —
          // these are usually unrecoverable in the same shape (auth, network,
          // model-not-found). Caller can decide whether to retry the whole op.
          lastError = callResult.errorMessage;
          break;
        }

        const parseResult: ParseResult<T> = definition.outputParser(
          callResult.fullText,
        );

        if (parseResult.success) {
          this.recordTokens(options.sessionId, {
            operationId: definition.operationId,
            provider: resolved.provider,
            model: resolved.model.id,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd: totalCostUsd,
            timestamp: new Date().toISOString(),
          });

          return {
            operationId: definition.operationId,
            status: "success",
            output: parseResult,
            error: null,
            tokenUsage: {
              input: totalInputTokens,
              output: totalOutputTokens,
            },
            cost: totalCostUsd,
            durationMs: Date.now() - startTime,
          };
        }

        // Parse failed.
        lastError = parseResult.error;

        // If we have a retry budget AND the op declared a retry hint,
        // build a corrective message list and loop.
        const canRetry =
          attempt < maxAttempts - 1 && definition.retryPrompt !== null;
        if (!canRetry) break;

        currentMessages = buildRetryMessages(
          definition.messages,
          callResult.fullText,
          parseResult.error,
          definition.retryPrompt!,
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    // All attempts exhausted (or transport error before parsing).
    this.recordTokens(options.sessionId, {
      operationId: definition.operationId,
      provider: resolved.provider,
      model: resolved.model.id,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      timestamp: new Date().toISOString(),
    });

    return {
      operationId: definition.operationId,
      status: "failed",
      output: null,
      error: lastError ?? "Unknown failure",
      tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
      cost: totalCostUsd,
      durationMs: Date.now() - startTime,
    };
  }

  // Internal: one streaming call to pi-ai. Intentionally `protected` so unit
  // tests can subclass and stub the network without going through pi-ai.
  protected async streamCall(args: {
    model: ReturnType<typeof resolveModel>["model"];
    context: Context;
    apiKey: string | undefined;
    signal: AbortSignal;
    onChunk?: (chunk: string) => void;
  }): Promise<StreamCallResult> {
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let errorMessage: string | null = null;

    const s = stream(args.model, args.context, {
      apiKey: args.apiKey,
      signal: args.signal,
    });

    try {
      for await (const event of s) {
        if (event.type === "text_delta") {
          fullText += event.delta;
          args.onChunk?.(event.delta);
        } else if (event.type === "error") {
          errorMessage =
            event.error?.errorMessage ?? "pi-ai stream returned error event";
        }
      }
      // pi-ai populates the final usage on the resolved AssistantMessage.
      const final = await s.result();
      const usage = final.usage;
      if (usage) {
        inputTokens = usage.input ?? 0;
        outputTokens = usage.output ?? 0;
        costUsd = usage.cost?.total ?? 0;
        // If pi-ai wrote an errorMessage onto the final assistant message,
        // surface it (handles cases where no `error` event was emitted but
        // the call still failed).
        if (!errorMessage && final.errorMessage) {
          errorMessage = final.errorMessage;
        }
      }
    } catch (err) {
      // Caught from `for await` itself — usually an aborted signal or a
      // network error that pi-ai threw rather than reporting via event.
      errorMessage = (err as Error).message ?? "Unknown stream error";
    }

    return { fullText, inputTokens, outputTokens, costUsd, errorMessage };
  }

  private recordTokens(
    sessionId: string | undefined,
    record: TokenRecord,
  ): void {
    if (sessionId === undefined) return;
    this.tokenTracker.record(sessionId, record);
  }
}

// Convert our internal LLMMessage into pi-ai's stricter Message shape.
// pi-ai requires a numeric `timestamp` on user messages — we add one here so
// callers don't have to think about it.
function toPiAiMessage(m: LLMMessage): Context["messages"][number] {
  if (m.role === "user") {
    return { role: "user", content: m.content, timestamp: Date.now() };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: m.content }],
      api: "openai-completions",
      provider: "ollama",
      model: "n/a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }
  // System messages are passed via Context.systemPrompt, not the messages
  // array. If a caller put a system role in messages, treat it as user
  // content prefixed with [system] so it still reaches the model.
  return {
    role: "user",
    content: `[system] ${m.content}`,
    timestamp: Date.now(),
  };
}

// Bridge two AbortSignals into one. Aborts when EITHER source aborts.
// Used to combine the caller's cancel signal with our internal timeout signal.
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctl = new AbortController();
  const onAbort = (signal: AbortSignal) => () => {
    ctl.abort(signal.reason);
  };
  a.addEventListener("abort", onAbort(a), { once: true });
  b.addEventListener("abort", onAbort(b), { once: true });
  return ctl.signal;
}
