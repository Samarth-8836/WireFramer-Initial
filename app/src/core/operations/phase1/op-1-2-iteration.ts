import type { ContextBuilder } from "@core/context-builder";
import type {
  OperationExecutor,
  SSEWriter,
  TwoAIResult,
} from "@core/operation-executor";
import {
  createVisibleChunkFilter,
  executeTwoAIPattern,
  extractGenerationContext,
  parseMarkdownSections,
  type GenerationContextData,
} from "@core/operation-executor";
import type { OperationDefinition, ParsedOutput } from "@core/types";

// Op 1.2 — Iteration.
//
// Runs on every Phase 1 message after the first (router: phase-1, docs
// exist). Structurally identical to op-1-1 except:
//   - Call A uses `buildPhase1Iteration`, which includes the full chat
//     history via the Summarizer.
//   - The generation_context is always a COMPLETE snapshot per spec
//     §17.2, so the doc generator regenerates the whole contract every
//     turn (storage will bump the version number on each write).

const CONTRACT_SECTIONS = [
  "Goal Statement",
  "Personas",
  "Entity Map",
  "Boundaries",
];

export async function executeIteration(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  userMessage: string,
  sse: SSEWriter,
  sessionId: string,
): Promise<TwoAIResult> {
  const callAContext = await contextBuilder.buildPhase1Iteration(
    sessionId,
    userMessage,
  );

  // Strip the <generation_context> block from the streamed chat bubble.
  const chunkFilter = createVisibleChunkFilter((text) => sse.sendChunk(text));

  const callADef: OperationDefinition = {
    operationId: "op-1-2",
    systemPrompt: callAContext.systemPrompt,
    messages: callAContext.messages,
    expectedOutputFormat: "structured",
    outputParser: extractGenerationContext,
    maxRetries: 1,
    retryPrompt:
      "Respond with a 1-2 sentence chat message followed by a <generation_context> YAML block containing the COMPLETE updated product definition — not just the change.",
    timeoutMs: 120_000,
    role: "reasoning",
    onStreamChunk: (chunk) => chunkFilter.push(chunk),
  };

  const result = await executeTwoAIPattern(
    executor,
    callADef,
    async (contextData) => {
      const genContextString = normalizeGenerationContext(contextData);
      const callBContext =
        await contextBuilder.buildProjectContractGeneratorContext(
          genContextString,
        );
      return {
        operationId: "op-1-2",
        systemPrompt: callBContext.systemPrompt,
        messages: callBContext.messages,
        expectedOutputFormat: "markdown",
        outputParser: (raw) =>
          parseMarkdownSections(raw, CONTRACT_SECTIONS),
        maxRetries: 1,
        retryPrompt:
          "Produce a markdown document with exactly four level-2 headers: ## Goal Statement, ## Personas, ## Entity Map, ## Boundaries.",
        timeoutMs: 120_000,
        role: "reasoning",
      };
    },
    (callAOutput: ParsedOutput) => {
      const data = callAOutput.data as GenerationContextData;
      return {
        contextData: data.generationContextRaw,
        visibleResponse: data.visibleResponse,
        isClarifyingQuestion: data.isClarifyingQuestion,
      };
    },
    { sessionId },
  );

  // Flush any held-back tail in case Call A asked a clarifying question
  // (no <generation_context> tag means nothing triggered the filter's stop).
  chunkFilter.flush();
  return result;
}

function normalizeGenerationContext(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
