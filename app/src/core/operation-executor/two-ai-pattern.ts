import type {
  OperationDefinition,
  OperationResult,
  ParsedOutput,
} from "@core/types";

import type { ExecuteOptions, OperationExecutor } from "./executor";

// The Two-AI Pattern is the universal interaction shape used by every
// user-facing operation that produces *both* a chat message and a
// structured document (Phase 1: ops 1.1, 1.2; Phase 2: op 2.7a).
//
// Flow:
//   1. Call A — Conversational AI. Talks like a person. Either asks a
//      clarifying question OR emits a hidden <generation_context> block
//      summarizing what the document generator should produce.
//   2. Context extractor — pulls the visible response and the embedded
//      structured context out of Call A's parsed output.
//   3. If the user got a clarifying question (no context block), STOP.
//      Return early with `isClarifyingQuestion: true`. Call B does not run.
//   4. Otherwise — Call B. Document Generator. Takes the context from
//      Call A and produces the actual markdown/YAML document.
//
// Why split into two calls instead of one?
//   - Call A is conversational and needs the full chat history. Call B is
//     deterministic and only needs the extracted context — much smaller
//     prompt, much cheaper, much more reliable structured output.
//   - The user sees Call A streaming in real time. Call B runs in the
//     background after Call A finishes; the document panel updates when
//     Call B completes.

export interface TwoAIResult {
  // What the user sees in chat.
  visibleResponse: string;
  // The document content from Call B (null if Call A asked a clarifying question).
  generatedDocument: string | null;
  // Parsed structured data from Call A's <generation_context> or <change_context>.
  structuredData: unknown | null;
  // True when Call A asked a question instead of producing context.
  isClarifyingQuestion: boolean;
  // Raw underlying call results, for token tracking and debugging.
  callAResult: OperationResult;
  callBResult: OperationResult | null;
}

// The shape the context extractor must return — keeps the orchestrator
// agnostic about whether the op uses generation_context or change_context.
export interface ExtractedContext {
  contextData: unknown;
  visibleResponse: string;
  isClarifyingQuestion: boolean;
}

export type ContextExtractor = (
  callAOutput: ParsedOutput,
) => ExtractedContext;

export type CallBFactory = (contextData: unknown) => OperationDefinition;

export async function executeTwoAIPattern(
  executor: OperationExecutor,
  callADefinition: OperationDefinition,
  callBFactory: CallBFactory,
  contextExtractor: ContextExtractor,
  options: ExecuteOptions = {},
): Promise<TwoAIResult> {
  const callAResult = await executor.execute(callADefinition, options);

  if (callAResult.status === "failed" || !callAResult.output) {
    throw new Error(
      `Two-AI: Call A (${callADefinition.operationId}) failed: ${callAResult.error}`,
    );
  }

  const extracted = contextExtractor(callAResult.output);

  if (extracted.isClarifyingQuestion) {
    return {
      visibleResponse: extracted.visibleResponse,
      generatedDocument: null,
      structuredData: null,
      isClarifyingQuestion: true,
      callAResult,
      callBResult: null,
    };
  }

  const callBDef = callBFactory(extracted.contextData);
  const callBResult = await executor.execute(callBDef, options);

  if (callBResult.status === "failed" || !callBResult.output) {
    throw new Error(
      `Two-AI: Call B (${callBDef.operationId}) failed: ${callBResult.error}`,
    );
  }

  // Call B's parsed output may be a markdown-sections object or a raw text
  // payload. Pick the most useful representation for callers.
  const callBData = callBResult.output.data as
    | { fullMarkdown?: string }
    | undefined;
  const generatedDocument =
    callBData?.fullMarkdown ?? callBResult.output.rawText;

  return {
    visibleResponse: extracted.visibleResponse,
    generatedDocument,
    structuredData: extracted.contextData,
    isClarifyingQuestion: false,
    callAResult,
    callBResult,
  };
}
