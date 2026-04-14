import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { RoleName } from "@core/types";

/**
 * Provider registry for UX Builder.
 *
 * Two providers are wired by default:
 *   - "groq":   hosted, via pi-ai's built-in Groq models. API key from GROQ_API_KEY.
 *   - "ollama": local, via pi-ai's openai-completions adapter pointed at Ollama's
 *               OpenAI-compatible endpoint. No API key required.
 *
 * Each operation in the system asks for a model by *role* (see RoleName below),
 * not by a hard-coded provider. Which concrete provider/model backs each role is
 * controlled by env vars, so a developer can flip the whole pipeline to local
 * models for iteration without changing code.
 *
 * Env vars (all optional, sensible defaults):
 *   LLM_PROVIDER             = "groq" | "ollama"   (default: "groq")
 *   LLM_MODEL_FAST           Model id used for cheap/batch ops    (default per provider below)
 *   LLM_MODEL_REASONING      Model id used for user-facing ops    (default per provider below)
 *   GROQ_API_KEY             Required when provider=groq
 *   OLLAMA_BASE_URL          Ollama OpenAI-compat base URL        (default: http://localhost:11434/v1)
 *   OLLAMA_MODEL             Override default Ollama model id     (default: qwen3.5:4b)
 */

export type ProviderName = "groq" | "ollama";

// Re-export RoleName so call-sites can import it from either @core/types or
// @core/llm/providers without thinking about which is canonical.
export type { RoleName };

export interface ResolvedModel {
  role: RoleName;
  provider: ProviderName;
  model: Model<any>;
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_OLLAMA_MODEL_ID = "qwen3.5:4b";

// Default Groq model picks. These are all built into pi-ai's model registry.
const DEFAULT_GROQ_FAST = "llama-3.1-8b-instant";
const DEFAULT_GROQ_REASONING = "llama-3.3-70b-versatile";

function currentProvider(): ProviderName {
  const raw = (process.env.LLM_PROVIDER ?? "groq").toLowerCase();
  if (raw === "groq" || raw === "ollama") return raw;
  throw new Error(
    `Unknown LLM_PROVIDER "${raw}". Supported: "groq", "ollama".`,
  );
}

function buildOllamaModel(modelId: string): Model<"openai-completions"> {
  // Qwen3 family enables "thinking" mode by default, which produces hundreds
  // of tokens of internal chain-of-thought before answering. That's wasteful
  // for the structured-output ops we run here (titles, classifications, doc
  // generation) — we want short focused responses.
  //
  // Setting `reasoning: true` plus `compat.thinkingFormat: "qwen-chat-template"`
  // makes pi-ai send `chat_template_kwargs: { enable_thinking: false }` to
  // Ollama (because we never pass `reasoningEffort` in the stream options).
  // Ollama forwards it to the qwen3 chat template, which disables thinking.
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 8192,
    compat: {
      thinkingFormat: "qwen-chat-template",
    },
  };
}

export function resolveModel(role: RoleName): ResolvedModel {
  const provider = currentProvider();

  if (provider === "ollama") {
    const modelId = process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL_ID;
    return { role, provider, model: buildOllamaModel(modelId) };
  }

  // Groq
  const fastId = process.env.LLM_MODEL_FAST ?? DEFAULT_GROQ_FAST;
  const reasoningId = process.env.LLM_MODEL_REASONING ?? DEFAULT_GROQ_REASONING;
  const modelId = role === "fast" ? fastId : reasoningId;
  const model = getModel("groq", modelId as any);
  return { role, provider, model };
}

// pi-ai's openai-completions transport requires a non-empty apiKey even for
// providers that don't authenticate (Ollama). Centralized here so the
// Operation Executor doesn't need provider-specific knowledge.
export function getApiKey(provider: ProviderName): string | undefined {
  if (provider === "ollama") return "ollama";
  if (provider === "groq") return process.env.GROQ_API_KEY;
  return undefined;
}

export function describeActiveConfig(): {
  provider: ProviderName;
  fast: string;
  reasoning: string;
  baseUrl?: string;
} {
  const provider = currentProvider();
  if (provider === "ollama") {
    const id = process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL_ID;
    return {
      provider,
      fast: id,
      reasoning: id,
      baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    };
  }
  return {
    provider,
    fast: process.env.LLM_MODEL_FAST ?? DEFAULT_GROQ_FAST,
    reasoning: process.env.LLM_MODEL_REASONING ?? DEFAULT_GROQ_REASONING,
  };
}
