import {
  describeActiveConfig,
  getApiKey,
  getBaseUrl,
  resolveModel,
} from "@core/llm/providers";
import { streamOpenRouter } from "@core/llm/openrouter-client";
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
// the LLM. Every AI call — Phase 1 chat, Phase 2 batch generation, drift
// checks, validations, diagnoses — flows through `execute()`.
//
// Responsibilities:
//   1. Resolve role -> concrete model slug via providers.ts.
//   2. Stream via the OpenRouter client; accumulate text + usage;
//      forward chunks to onStreamChunk.
//   3. Run the op's parser on the accumulated text.
//   4. On parse failure: build retry messages and try again, up to maxRetries.
//   5. On transport failure: surface the error message into the result.
//   6. Track per-session tokens via TokenTracker.
//
// What it deliberately does NOT do:
//   - Decide which prompt to use (that's the job of the prompt registry).
//   - Persist the result (storage layer).
//   - Coordinate multi-call patterns (that's two-ai-pattern.ts).
//   - Decide retry strategy beyond the per-op maxRetries.

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
    const apiKey = getApiKey();

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
    let currentMessages: LLMMessage[] = [...definition.messages];
    let lastError: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const callResult = await this.streamCall({
          modelId: resolved.modelId,
          systemPrompt: definition.systemPrompt,
          messages: currentMessages,
          apiKey,
          signal,
          onChunk: definition.onStreamChunk,
        });

        totalInputTokens += callResult.inputTokens;
        totalOutputTokens += callResult.outputTokens;
        totalCostUsd += callResult.costUsd;

        if (callResult.errorMessage !== null) {
          // Transport-level error from OpenRouter. Don't retry the parser
          // loop — these are usually unrecoverable in the same shape
          // (auth, network, model-not-found). The caller can decide
          // whether to retry the whole op.
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
            model: resolved.modelId,
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
      model: resolved.modelId,
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

  // Internal: one streaming call to the LLM. Intentionally `protected` so
  // unit tests can subclass and stub the network without going through
  // OpenRouter.
  protected async streamCall(args: {
    modelId: string;
    systemPrompt: string;
    messages: LLMMessage[];
    apiKey: string | undefined;
    signal: AbortSignal;
    onChunk?: (chunk: string) => void;
  }): Promise<StreamCallResult> {
    if (!args.apiKey) {
      return {
        fullText: "",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        errorMessage:
          "OPENROUTER_API_KEY is not set. Add it to app/.env.local and restart the dev server.",
      };
    }

    const result = await streamOpenRouter({
      apiKey: args.apiKey,
      model: args.modelId,
      systemPrompt: args.systemPrompt,
      // LLMMessage's role type is "user" | "assistant" | "system"; the
      // OpenRouter client accepts the same union.
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      signal: args.signal,
      onChunk: args.onChunk,
      baseUrl: getBaseUrl(),
    });

    // OpenRouter's streaming response doesn't return a per-call cost on
    // the wire for most free/low-cost models. The TokenTracker records
    // zero cost; surface a real number if OpenRouter exposes one in a
    // later version of their API.
    return {
      fullText: result.fullText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: 0,
      errorMessage: result.errorMessage,
    };
  }

  private recordTokens(
    sessionId: string | undefined,
    record: TokenRecord,
  ): void {
    if (sessionId === undefined) return;
    this.tokenTracker.record(sessionId, record);
  }
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

// Re-export describeActiveConfig so callers that imported it from the
// executor module before the refactor don't need to touch their imports.
export { describeActiveConfig };
