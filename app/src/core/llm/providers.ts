import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";

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
export type RoleName = "fast" | "reasoning";

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
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 8192,
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
