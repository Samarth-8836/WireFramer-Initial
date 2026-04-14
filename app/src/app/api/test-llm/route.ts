import type { Context } from "@mariozechner/pi-ai";
import { stream } from "@mariozechner/pi-ai";
import { describeActiveConfig, resolveModel } from "@core/llm/providers";
import type { NextRequest } from "next/server";

// Proof-of-life route. Streams a short response via whichever provider is
// currently configured (Groq hosted OR local Ollama). This is the Sprint 0
// verification endpoint — it intentionally bypasses the Operation Executor
// so we can prove the pi-ai integration works end-to-end first.
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
  const context: Context = {
    systemPrompt: "You are a terse assistant. Answer with minimum words.",
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  };

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, event: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const readable = new ReadableStream({
    async start(controller) {
      send(controller, {
        type: "meta",
        config: describeActiveConfig(),
        role,
        modelId: resolved.model.id,
      });

      try {
        const s = stream(resolved.model, context, {
          // Ollama ignores the key but pi-ai's openai-completions transport
          // still requires *some* string. Hosted providers pull from env.
          apiKey:
            resolved.provider === "ollama"
              ? "ollama"
              : process.env.GROQ_API_KEY,
        });
        for await (const event of s) {
          if (event.type === "text_delta") {
            send(controller, { type: "text_delta", delta: event.delta });
          } else if (event.type === "done") {
            send(controller, { type: "done", reason: event.reason });
          } else if (event.type === "error") {
            const errMsg =
              event.error?.errorMessage ??
              JSON.stringify(event.error);
            send(controller, { type: "error", reason: event.reason, error: errMsg });
          }
        }
        const final = await s.result();
        send(controller, {
          type: "final",
          usage: final.usage,
        });
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
