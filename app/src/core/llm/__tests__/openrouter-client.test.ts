import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamOpenRouter } from "../openrouter-client";

// We stub global.fetch so these tests run without network.
// Each stub returns a ReadableStream that emits exactly the SSE frames
// the test wants, then closes — the same shape OpenRouter sends on the
// wire.

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("streamOpenRouter", () => {
  it("parses content deltas and surfaces final usage", async () => {
    const frames = [
      `data: ${JSON.stringify({
        id: "r1",
        choices: [{ delta: { content: "Hello" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "r1",
        choices: [{ delta: { content: " world" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "r1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const chunks: string[] = [];
    global.fetch = (async () => sseResponse(frames)) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "test-key",
      model: "inclusionai/ling-2.6-1t:free",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
      onChunk: (d) => chunks.push(d),
    });

    expect(result.errorMessage).toBeNull();
    expect(result.fullText).toBe("Hello world");
    expect(chunks).toEqual(["Hello", " world"]);
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(2);
  });

  it("handles tokens split across multiple reads (buffer boundaries)", async () => {
    // Simulate the real-world case where a single SSE frame arrives in
    // two reads — the parser must hold the partial frame in its buffer
    // and merge it with the next chunk.
    const frame1 =
      'data: {"id":"r1","choices":[{"delta":{"content":"Hel';
    const frame2 =
      'lo"}}]}\n\ndata: {"id":"r1","choices":[{"delta":{"content":" world"}}]}\n\n';
    global.fetch = (async () => sseResponse([frame1, frame2])) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.fullText).toBe("Hello world");
  });

  it("ignores keep-alive comments (`: ...` lines)", async () => {
    const frames = [
      ": OPENROUTER PROCESSING\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    global.fetch = (async () => sseResponse(frames)) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.errorMessage).toBeNull();
    expect(result.fullText).toBe("ok");
  });

  it("surfaces inline error events from the stream body", async () => {
    const frames = [
      `data: ${JSON.stringify({
        error: { message: "upstream model unavailable", code: 503 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    global.fetch = (async () => sseResponse(frames)) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.errorMessage).toMatch(/upstream model unavailable/);
    expect(result.fullText).toBe("");
  });

  it("returns HTTP error text when OpenRouter returns a non-OK response", async () => {
    global.fetch = (async () =>
      new Response('{"error":"bad key"}', {
        status: 401,
      })) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "wrong",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.errorMessage).toMatch(/401/);
    expect(result.errorMessage).toMatch(/bad key/);
  });

  it("sends systemPrompt as the first system message in the request body", async () => {
    let capturedBody: unknown = null;
    global.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return sseResponse(["data: [DONE]\n\n"]);
    }) as FetchLike;

    await streamOpenRouter({
      apiKey: "k",
      model: "test-model",
      systemPrompt: "you are a bot",
      messages: [{ role: "user", content: "hello" }],
    });

    const body = capturedBody as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "you are a bot" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("ignores malformed JSON frames without failing the whole stream", async () => {
    const frames = [
      "data: {not-json\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    global.fetch = (async () => sseResponse(frames)) as FetchLike;

    const result = await streamOpenRouter({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.errorMessage).toBeNull();
    expect(result.fullText).toBe("ok");
  });

  it("catches network errors thrown by fetch and surfaces them", async () => {
    global.fetch = (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    // Swallow the expected unhandled-rejection log spam from vi.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await streamOpenRouter({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
    });
    warn.mockRestore();
    expect(result.errorMessage).toMatch(/ECONNREFUSED/);
  });
});
