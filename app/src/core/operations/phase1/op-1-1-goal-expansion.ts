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

// Op 1.1 — Goal Expansion.
//
// Runs on the first message of a new session (router: phase-1, no docs).
// Uses the Two-AI pattern:
//
//   Call A: Phase 1 Conversational AI. Sees just the user message (no
//           history). Produces a 1-2 sentence visible response + a
//           <generation_context> YAML block. If the user's message is
//           truly ambiguous, Call A may skip the block and ask a
//           clarifying question, in which case Call B does not run.
//
//   Call B: Project Contract Generator. Takes the YAML context from Call
//           A and produces a markdown Project Contract with exactly four
//           sections: Goal Statement, Personas, Entity Map, Boundaries.

const CONTRACT_SECTIONS = [
  "Goal Statement",
  "Personas",
  "Entity Map",
  "Boundaries",
];

export async function executeGoalExpansion(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  userMessage: string,
  sse: SSEWriter,
  sessionId: string,
): Promise<TwoAIResult> {
  const callAContext =
    await contextBuilder.buildPhase1FirstMessage(userMessage);

  // Strip the <generation_context> block from the streamed chat bubble so
  // the user only sees the 1-2 sentence visible prefix. The full raw text
  // is still captured server-side by the executor and passed to Call B.
  const chunkFilter = createVisibleChunkFilter((text) => sse.sendChunk(text));

  const callADef: OperationDefinition = {
    operationId: "op-1-1",
    systemPrompt: callAContext.systemPrompt,
    messages: callAContext.messages,
    expectedOutputFormat: "structured",
    outputParser: extractGenerationContext,
    maxRetries: 1,
    retryPrompt:
      "Include a <generation_context> YAML block containing the complete product definition (goal, personas, entities, boundaries). Keep your visible chat message to 1-2 sentences.",
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
        operationId: "op-1-1",
        systemPrompt: callBContext.systemPrompt,
        messages: callBContext.messages,
        expectedOutputFormat: "markdown",
        outputParser: (raw) =>
          parseMarkdownSections(raw, CONTRACT_SECTIONS),
        maxRetries: 1,
        retryPrompt:
          "Produce a markdown document with exactly four level-2 headers: ## Goal Statement, ## Personas, ## Entity Map, ## Boundaries. No preamble, no code fences.",
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

  // If Call A asked a clarifying question (no <generation_context> tag),
  // flush the held-back tail so the user sees the full question.
  chunkFilter.flush();
  return result;
}

// The generation_context may come back as a parsed YAML object or as the
// raw YAML string. The Project Contract generator wants a string to embed
// in its user message — if we got an object, re-serialize as JSON with
// readable indentation (the doc generator handles both).
function normalizeGenerationContext(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
