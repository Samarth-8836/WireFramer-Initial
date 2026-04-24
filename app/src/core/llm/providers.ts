import type { RoleName } from "@core/types";

/**
 * Provider registry for UX Builder.
 *
 * Single provider: OpenRouter. We hit their OpenAI-compatible API directly
 * via native fetch (see `./openrouter-client.ts`) — no SDK.
 *
 * Every operation in the system asks for a model by *role* (fast or
 * reasoning). Both roles default to the same OpenRouter slug today;
 * developers can override per-role via env vars to save money on cheap
 * ops (e.g. session titles) while keeping a larger model for reasoning.
 *
 * Env vars (all optional except the API key):
 *   OPENROUTER_API_KEY     Required.
 *   OPENROUTER_BASE_URL    Default: https://openrouter.ai/api/v1
 *   LLM_MODEL_FAST         Model slug for cheap/batch ops.
 *   LLM_MODEL_REASONING    Model slug for user-facing ops.
 *                          Both default to inclusionai/ling-2.6-1t:free.
 */

export type ProviderName = "openrouter";

// Re-export RoleName so call-sites can import it from either @core/types or
// @core/llm/providers without thinking about which is canonical.
export type { RoleName };

export interface ResolvedModel {
  role: RoleName;
  provider: ProviderName;
  // The raw model slug (e.g. "inclusionai/ling-2.6-1t:free"). OpenRouter
  // takes this verbatim in the `model` field of the request body.
  modelId: string;
}

const DEFAULT_MODEL = "inclusionai/ling-2.6-1t:free";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function resolveModel(role: RoleName): ResolvedModel {
  const fast = process.env.LLM_MODEL_FAST ?? DEFAULT_MODEL;
  const reasoning = process.env.LLM_MODEL_REASONING ?? DEFAULT_MODEL;
  const modelId = role === "fast" ? fast : reasoning;
  return { role, provider: "openrouter", modelId };
}

// Single source of truth for the API key lookup — so the Operation
// Executor and the smoke route don't need to know the env var name.
export function getApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

export function getBaseUrl(): string {
  return process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
}

export function describeActiveConfig(): {
  provider: ProviderName;
  fast: string;
  reasoning: string;
  baseUrl: string;
} {
  return {
    provider: "openrouter",
    fast: process.env.LLM_MODEL_FAST ?? DEFAULT_MODEL,
    reasoning: process.env.LLM_MODEL_REASONING ?? DEFAULT_MODEL,
    baseUrl: getBaseUrl(),
  };
}
