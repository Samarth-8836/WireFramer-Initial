import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OperationDefinition, ParseResult } from "@core/types";

import { OperationExecutor } from "../executor";
import { parsePlainText } from "../parsers";

// Integration tests for the Operation Executor that hit a real LLM.
//
// These are skip-gated on Ollama reachability so the suite stays green when
// Ollama isn't running. Set `OLLAMA_BASE_URL` (default
// http://localhost:11434/v1) and ensure the model in `OLLAMA_MODEL` (default
// qwen3.5:4b) is pulled before running.
//
// We force LLM_PROVIDER=ollama for this suite so the executor uses the local
// model regardless of the developer's day-to-day env setting.

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";
const TAGS_URL = BASE_URL.replace(/\/v1\/?$/, "") + "/api/tags";

let ollamaReachable = false;
let originalProvider: string | undefined;
let originalModel: string | undefined;

beforeAll(async () => {
  originalProvider = process.env.LLM_PROVIDER;
  originalModel = process.env.OLLAMA_MODEL;
  process.env.LLM_PROVIDER = "ollama";
  process.env.OLLAMA_MODEL = MODEL;

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(TAGS_URL, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const body = (await res.json()) as { models?: { name: string }[] };
    ollamaReachable = (body.models ?? []).some((m) => m.name === MODEL);
  } catch {
    ollamaReachable = false;
  }
});

afterAll(() => {
  if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = originalProvider;
  if (originalModel === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = originalModel;
});

const itLive = (name: string, fn: () => Promise<void>, timeoutMs = 90_000) =>
  it(
    name,
    { timeout: timeoutMs },
    async () => {
      if (!ollamaReachable) {
        console.warn(
          `[skip] Ollama unreachable at ${TAGS_URL} or model ${MODEL} not pulled`,
        );
        return;
      }
      await fn();
    },
  );

describe("OperationExecutor (live Ollama integration)", () => {
  itLive("simple plain_text call returns a parsed result", async () => {
    const executor = new OperationExecutor();
    const def: OperationDefinition<{ text: string }> = {
      operationId: "op-1-0",
      systemPrompt:
        "You are a terse assistant. Answer with the minimum words possible.",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      expectedOutputFormat: "plain_text",
      outputParser: parsePlainText,
      maxRetries: 0,
      retryPrompt: null,
      timeoutMs: 60_000,
      role: "fast",
    };

    const result = await executor.execute(def, { sessionId: "test-session" });

    expect(result.status).toBe("success");
    expect(result.output).not.toBeNull();
    expect(result.tokenUsage.input).toBeGreaterThan(0);
    expect(result.tokenUsage.output).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    if (result.output) {
      expect(typeof result.output.data.text).toBe("string");
    }
  }, 90_000);

  itLive("forwards stream chunks to onStreamChunk callback", async () => {
    const executor = new OperationExecutor();
    const chunks: string[] = [];
    const def: OperationDefinition<{ text: string }> = {
      operationId: "op-1-0",
      systemPrompt: "You are a terse assistant.",
      messages: [{ role: "user", content: "Say: streaming works" }],
      expectedOutputFormat: "plain_text",
      outputParser: parsePlainText,
      maxRetries: 0,
      retryPrompt: null,
      timeoutMs: 60_000,
      role: "fast",
      onStreamChunk: (c) => chunks.push(c),
    };

    const result = await executor.execute(def);

    expect(result.status).toBe("success");
    expect(chunks.length).toBeGreaterThan(0);
    // The accumulated chunks should match the parsed text (modulo trim).
    if (result.output) {
      expect(chunks.join("").trim()).toContain(result.output.data.text);
    }
  }, 90_000);

  itLive("retries on parse failure and succeeds on the second attempt", async () => {
    const executor = new OperationExecutor();

    let parseAttempt = 0;
    // Fake parser: fails the first time, then accepts whatever comes back.
    const flakyParser = (raw: string): ParseResult<{ text: string }> => {
      parseAttempt += 1;
      if (parseAttempt === 1) {
        return {
          success: false,
          error: "synthetic parse failure for retry test",
          rawText: raw,
        };
      }
      return { success: true, data: { text: raw.trim() }, rawText: raw };
    };

    const def: OperationDefinition<{ text: string }> = {
      operationId: "op-1-0",
      systemPrompt: "You are a terse assistant.",
      messages: [{ role: "user", content: "Say: hello" }],
      expectedOutputFormat: "plain_text",
      outputParser: flakyParser,
      maxRetries: 1,
      retryPrompt: "Just respond with the literal text 'hello' and nothing else.",
      // Generous budget — local models are slow and the retry attempt grows
      // the prompt, so we need headroom for two sequential calls.
      timeoutMs: 300_000,
      role: "fast",
    };

    const result = await executor.execute(def);

    expect(parseAttempt).toBe(2);
    expect(result.status).toBe("success");
    // Both attempts should have contributed to the token count.
    expect(result.tokenUsage.input).toBeGreaterThan(0);
    expect(result.tokenUsage.output).toBeGreaterThan(0);
  }, 360_000);

  // The "exhausts retries when parser keeps failing" assertion is covered
  // by a fast unit test in executor.unit.test.ts that uses a stubbed
  // streamCall — running it as an integration test forced two sequential
  // Ollama calls per attempt and any reasonable budget tripped the per-op
  // timeout on slower hardware before naturally exhausting the retries.

  itLive("token tracker accumulates totals when sessionId is provided", async () => {
    const executor = new OperationExecutor();
    const def: OperationDefinition<{ text: string }> = {
      operationId: "op-1-0",
      systemPrompt: "You are a terse assistant.",
      messages: [{ role: "user", content: "Say: a" }],
      expectedOutputFormat: "plain_text",
      outputParser: parsePlainText,
      maxRetries: 0,
      retryPrompt: null,
      timeoutMs: 60_000,
      role: "fast",
    };

    await executor.execute(def, { sessionId: "tracker-test" });
    await executor.execute(def, { sessionId: "tracker-test" });

    const totals = executor.getTokenTracker().getSessionTotals("tracker-test");
    expect(totals.callCount).toBe(2);
    expect(totals.totalInputTokens).toBeGreaterThan(0);
    expect(totals.totalOutputTokens).toBeGreaterThan(0);
  }, 180_000);
});
