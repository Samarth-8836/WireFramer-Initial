import type { NextRequest } from "next/server";

import {
  describeActiveConfig,
  getApiKey,
  resolveModel,
} from "@core/llm/providers";
import { streamOpenRouter } from "@core/llm/openrouter-client";

// Proof-of-life smoke route. Streams a short response via OpenRouter so
// you can verify the API key + the selected model work without going
// through the full Operation Executor.
//
// Usage:
//   GET /api/test-llm                     -> uses the "reasoning" role
//   GET /api/test-llm?role=fast           -> uses the "fast" role
//   GET /api/test-llm?prompt=Say+hi       -> custom user prompt

export async function GET(req: NextRequest) {
  const role = (req.nextUrl.searchParams.get("role") ?? "reasoning") as
    | "fast"
    | "reasoning";
  const prompt =
    req.nextUrl.searchParams.get("prompt") ??
    'Say "Hello from the model" and nothing else.';

  const resolved = resolveModel(role);
  const apiKey = getApiKey();

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, event: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const readable = new ReadableStream({
    async start(controller) {
      send(controller, {
        type: "meta",
        config: describeActiveConfig(),
        role,
        modelId: resolved.modelId,
      });

      if (!apiKey) {
        send(controller, {
          type: "error",
          error: "OPENROUTER_API_KEY is not set in .env.local",
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      try {
        const result = await streamOpenRouter({
          apiKey,
          model: resolved.modelId,
          systemPrompt: "You are a terse assistant. Answer with minimum words.",
          messages: [{ role: "user", content: prompt }],
          onChunk: (delta) => {
            send(controller, { type: "text_delta", delta });
          },
        });

        if (result.errorMessage) {
          send(controller, { type: "error", error: result.errorMessage });
        } else {
          send(controller, { type: "done", reason: "stop" });
          send(controller, {
            type: "final",
            usage: {
              input: result.inputTokens,
              output: result.outputTokens,
            },
          });
        }
      } catch (err) {
        send(controller, {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
