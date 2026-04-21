// Op 2.7a — Phase 2 Conversational AI.
//
// Processes a user message during Phase 2. Produces a visible response
// + a <change_context> YAML block that the cascade router uses to determine
// what needs updating. Short-circuits on clarifying questions.

import type { ContextBuilder } from "@core/context-builder";
import type { OperationExecutor, SSEWriter } from "@core/operation-executor";
import { extractChangeContext } from "@core/operation-executor";
import type { OperationDefinition } from "@core/types";

export interface Phase2ConversationalResult {
  visibleResponse: string;
  changeContextRaw: string | null;
  changeContextParsed: Record<string, unknown> | null;
  isClarifyingQuestion: boolean;
}

export async function executePhase2Conversational(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  sessionId: string,
  userMessage: string,
  screenRef: string | null,
  sse: SSEWriter,
): Promise<Phase2ConversationalResult> {
  const context = await contextBuilder.buildPhase2ConversationalContext(
    sessionId,
    userMessage,
    screenRef,
  );

  const def: OperationDefinition = {
    operationId: "op-2-7a",
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    expectedOutputFormat: "structured",
    outputParser: extractChangeContext,
    maxRetries: 1,
    retryPrompt:
      "Include a <change_context> block with scope and description, or ask a clarifying question.",
    timeoutMs: 120_000,
    role: "reasoning",
    onStreamChunk: (chunk) => sse.sendChunk(chunk),
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-7a failed: ${result.error ?? "unknown"}`);
  }

  const data = result.output.data as Record<string, unknown>;

  return {
    visibleResponse: (data.visibleResponse as string) ?? "",
    changeContextRaw: (data.changeContext as string) ?? null,
    changeContextParsed: data.changeContext
      ? parseChangeContextYaml(data.changeContext as string)
      : null,
    isClarifyingQuestion: (data.isClarifyingQuestion as boolean) ?? false,
  };
}

function parseChangeContextYaml(raw: string): Record<string, unknown> | null {
  try {
    // Dynamic import would be cleaner but yaml is already a dep.
    const { parse } = require("yaml");
    return parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
