// Native OpenRouter streaming client.
//
// OpenRouter exposes an OpenAI-compatible chat-completions endpoint at
// https://openrouter.ai/api/v1/chat/completions. We hit it with a plain
// `fetch()` — no SDK — and parse the SSE response manually. Keeping this
// file tiny and dependency-free makes it easy to swap providers later
// (just implement another `streamXxx()` with the same result shape).
//
// Why no SDK:
//   - One fewer dep that can break, get deprecated, or drift from the
//     wire format.
//   - The streaming format is standard OpenAI SSE. A ~50-line parser
//     handles everything we need.
//
// Event format on the wire:
//   data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
//   data: {"id":"...","choices":[{"delta":{"content":" world"}}]}
//   ...
//   data: {"id":"...","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
//   data: [DONE]
//
// The final chunk's `usage` field is gated behind the
// `stream_options: { include_usage: true }` request flag. We always set
// it so the Operation Executor can record token counts.

export interface OpenRouterMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface OpenRouterStreamOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: OpenRouterMessage[];
  signal?: AbortSignal;
  onChunk?: (delta: string) => void;
  // Override the default base URL (useful for tests or self-hosted
  // gateways that speak the same protocol).
  baseUrl?: string;
  // Title shown in the OpenRouter dashboard / used as referrer. Nice-to-have
  // for debugging provider-side issues.
  referrer?: string;
  title?: string;
}

export interface OpenRouterStreamResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  // Null = success. Non-null = transport or provider-level error.
  errorMessage: string | null;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export async function streamOpenRouter(
  opts: OpenRouterStreamOptions,
): Promise<OpenRouterStreamResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

  // OpenAI-compat format requires the system prompt to be the first
  // message with role: "system". We accept systemPrompt separately on
  // the input API (matching the Operation Executor's shape) and merge
  // it here so callers don't have to think about it.
  const apiMessages: OpenRouterMessage[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.messages,
  ];

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        // OpenRouter's recommended attribution headers. Optional but
        // helps identify the integration in their dashboard.
        "HTTP-Referer":
          opts.referrer ?? "https://github.com/Samarth-8836/WireFramer-Initial",
        "X-Title": opts.title ?? "UX Builder",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      fullText: "",
      inputTokens: 0,
      outputTokens: 0,
      errorMessage:
        err instanceof Error ? err.message : "Network error hitting OpenRouter",
    };
  }

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      fullText: "",
      inputTokens: 0,
      outputTokens: 0,
      errorMessage: `OpenRouter HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let errorMessage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by newlines. Pop full lines off the
      // buffer, keep the partial trailing fragment for the next iteration.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        // OpenRouter sometimes sends ": OPENROUTER PROCESSING" keep-alive
        // comments — ignore anything that isn't a `data:` frame.
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        try {
          const event = JSON.parse(payload);
          // Provider-level error delivered inside the stream (e.g. auth
          // expired mid-response, upstream model unavailable).
          if (event.error) {
            errorMessage =
              (event.error.message as string) ??
              JSON.stringify(event.error);
            continue;
          }

          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            fullText += delta;
            opts.onChunk?.(delta);
          }

          if (event.usage) {
            inputTokens = (event.usage.prompt_tokens as number) ?? inputTokens;
            outputTokens =
              (event.usage.completion_tokens as number) ?? outputTokens;
          }
        } catch {
          // Malformed JSON frame — skip it. Not worth failing the whole
          // stream over a single bad line; a truly broken stream will
          // surface via errorMessage or an empty fullText on completion.
        }
      }
    }
  } catch (err) {
    // AbortError or network disconnect. If we already recorded a
    // provider-level error, keep that; otherwise surface the transport one.
    if (!errorMessage) {
      errorMessage =
        err instanceof Error ? err.message : "Stream read error";
    }
  }

  return { fullText, inputTokens, outputTokens, errorMessage };
}
