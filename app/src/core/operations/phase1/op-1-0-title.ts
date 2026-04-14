import type { OperationExecutor } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE1_PROMPT_SLUGS } from "@core/prompts";
import type { ParseResult } from "@core/types";

// Op 1.0 — Session Title.
//
// Fire-and-forget utility called during createSession to give the session
// a short, human-readable title in the sidebar. Cheap op (role=fast), one
// retry on parse failure, silent fallback on total failure: if the model
// can't produce 3-5 words we just truncate the user's first message.
//
// Spec §17.1. The parser enforces the word-count constraint because the
// UI budget for titles is tight — longer strings wrap badly.

const MIN_TITLE_WORDS = 3;
const MAX_TITLE_WORDS = 5;

export async function generateTitle(
  executor: OperationExecutor,
  promptRegistry: IPromptRegistry,
  userMessage: string,
  sessionId?: string,
): Promise<string> {
  const parseTitle = (text: string): ParseResult<{ title: string }> => {
    const cleaned = text
      .trim()
      // Strip quotes, periods, and any surrounding markdown bullet/emphasis.
      .replace(/^["'*`]+|["'*`.]+$/g, "")
      .trim();
    const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < MIN_TITLE_WORDS || words.length > MAX_TITLE_WORDS) {
      return {
        success: false,
        error: `Title must be ${MIN_TITLE_WORDS}-${MAX_TITLE_WORDS} words, got ${words.length} ("${cleaned}")`,
        rawText: text,
      };
    }
    return {
      success: true,
      data: { title: cleaned },
      rawText: text,
    };
  };

  const result = await executor.execute(
    {
      operationId: "op-1-0",
      systemPrompt: promptRegistry.get(PHASE1_PROMPT_SLUGS.sessionTitle),
      messages: [{ role: "user", content: userMessage }],
      expectedOutputFormat: "plain_text",
      outputParser: parseTitle,
      maxRetries: 1,
      retryPrompt:
        "Respond with ONLY a title between 3 and 5 words. No punctuation, no quotes, just the plain words.",
      timeoutMs: 15_000,
      role: "fast",
    },
    { sessionId },
  );

  if (result.status === "success" && result.output) {
    return result.output.data.title;
  }

  // Fallback: use the first 5 words of the user message, padded to 3 if
  // the message itself is shorter. "New Session" is the ultimate bail-out.
  const fallback = userMessage
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ");
  if (fallback.split(/\s+/).length >= MIN_TITLE_WORDS) {
    return fallback;
  }
  return "New Session";
}
