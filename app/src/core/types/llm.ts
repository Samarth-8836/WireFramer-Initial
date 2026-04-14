import type { OperationId } from "./operations";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMUsage {
  input: number;
  output: number;
  costUsd?: number;
}

export interface ParsedOutput<T = unknown> {
  success: true;
  data: T;
  rawText: string;
}

export interface ParseError {
  success: false;
  error: string;
  rawText: string;
}

export type ParseResult<T = unknown> = ParsedOutput<T> | ParseError;

export type ExpectedOutputFormat =
  | "markdown"
  | "yaml"
  | "json"
  | "plain_text"
  | "structured";

// OperationDefinition is the contract every LLM call presents to the
// Operation Executor. Executor implementation lands in Sprint 2.
export interface OperationDefinition<T = unknown> {
  operationId: OperationId;
  systemPrompt: string;
  messages: LLMMessage[];
  expectedOutputFormat: ExpectedOutputFormat;
  outputParser: (rawOutput: string) => ParseResult<T>;
  maxRetries: number;
  retryPrompt: string | null;
  timeoutMs: number;
  // Optional pi-ai routing overrides. When unset, the executor asks the
  // provider registry for a default by role.
  provider?: string;
  model?: string;
  onStreamChunk?: (chunk: string) => void;
}

export interface OperationResult<T = unknown> {
  operationId: OperationId;
  status: "success" | "failed";
  output: ParsedOutput<T> | null;
  error: string | null;
  tokenUsage: { input: number; output: number };
  cost: number;
  durationMs: number;
}
