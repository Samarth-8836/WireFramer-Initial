import type {
  ChatMessage,
  LLMMessage,
  ParseResult,
  PhaseId,
} from "@core/types";
import type { OperationExecutor } from "@core/operation-executor";
import type { IStorage } from "@core/storage/interface";
import { RECENT_MESSAGE_PAIRS_TO_KEEP } from "@lib/constants";

// The Summarizer has two unrelated-looking jobs that share one ownership
// boundary: both read/write the conversational state the Context Builder
// needs to hand to the LLM.
//
//   1. Chat history compression. When a phase's raw chat history would blow
//      the prompt's token budget, summarize the oldest pairs into a single
//      system message and keep the most recent N pairs verbatim.
//
//   2. Phase 2 conversation summary maintenance. Append-only log of changes
//      made during Phase 2 iteration. The Context Builder surfaces this to
//      the LLM as "changes made so far" and uses it to flag recently
//      touched workflows/screens.
//
// Ownership: the Summarizer is the ONLY module in the Context Builder
// subsystem that holds an OperationExecutor reference. Keeping the LLM
// dependency concentrated here makes the rest of the Context Builder pure
// and synchronous (modulo I/O), which makes it much easier to test.

export class Summarizer {
  constructor(private readonly executor: OperationExecutor) {}

  async processHistory(
    messages: ChatMessage[],
    tokenBudget: number,
  ): Promise<LLMMessage[]> {
    if (messages.length === 0) return [];

    if (this.estimateTokens(messages) <= tokenBudget) {
      return messages.map(toLLMMessage);
    }

    const pairs = this.groupIntoPairs(messages);

    // Everything IS recent — nothing older to summarize. We return the
    // messages as-is and accept the overflow; the caller (Context Builder)
    // is responsible for deciding whether to truncate further. We'd rather
    // give the LLM a slightly over-budget context than fabricate a summary
    // from the same messages we'd have sent anyway.
    if (pairs.length <= RECENT_MESSAGE_PAIRS_TO_KEEP) {
      return messages.map(toLLMMessage);
    }

    const recentPairs = pairs.slice(-RECENT_MESSAGE_PAIRS_TO_KEEP);
    const olderPairs = pairs.slice(0, -RECENT_MESSAGE_PAIRS_TO_KEEP);
    const olderMessages = olderPairs.flat();

    const summary = await this.summarizeMessages(olderMessages);

    return [
      {
        role: "system",
        content: `Previous conversation summary:\n${summary}`,
      },
      ...recentPairs.flat().map(toLLMMessage),
    ];
  }

  async updateConversationSummary(
    storage: IStorage,
    sessionId: string,
    phaseId: PhaseId,
    iterationNumber: number,
    changeDescription: string,
    scope: string,
    affectedArtifacts: string[],
  ): Promise<void> {
    const existing = await storage.getConversationSummary(sessionId, phaseId);
    const entry = `Iteration ${iterationNumber}: ${changeDescription} [scope: ${scope}, affected: ${affectedArtifacts.join(", ")}]`;
    const merged = existing ? `${existing.summary}\n${entry}` : entry;

    await storage.upsertConversationSummary({
      sessionId,
      phaseId,
      summary: merged,
      lastUpdatedAt: new Date().toISOString(),
      messagesCovered: (existing?.messagesCovered ?? 0) + 1,
    });
  }

  private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) return "";
    const content = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    // NOTE: we reuse the op-1-0 id because the Operation Executor's token
    // tracker needs a valid OperationId string and there's no dedicated
    // "summarizer" op in the pipeline. Flagged as a blind spot — Sprint 4
    // may want a synthetic "util" op id so summarizer tokens don't get
    // attributed to the Phase 1 chat op.
    const result = await this.executor.execute({
      operationId: "op-1-0",
      systemPrompt:
        "Summarize the following conversation into a brief paragraph that captures every decision, change request, and the current state. Do not omit any decision or change.",
      messages: [{ role: "user", content }],
      expectedOutputFormat: "plain_text",
      outputParser: (raw: string): ParseResult<{ text: string }> => ({
        success: true,
        data: { text: raw.trim() },
        rawText: raw,
      }),
      maxRetries: 0,
      retryPrompt: null,
      timeoutMs: 30_000,
      role: "fast",
    });

    if (
      result.status === "success" &&
      result.output &&
      typeof (result.output.data as { text?: string }).text === "string"
    ) {
      return (result.output.data as { text: string }).text;
    }

    // Fallback: truncate the concatenated text. Better than losing the
    // chat history entirely when the cheap model is unavailable.
    return content.length > 500 ? `${content.slice(0, 500)}...` : content;
  }

  private estimateTokens(messages: ChatMessage[]): number {
    // Rough heuristic: ~4 chars per token. Deliberately conservative — we'd
    // rather summarize once too often than blow past a real context limit.
    return messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );
  }

  private groupIntoPairs(messages: ChatMessage[]): ChatMessage[][] {
    // A "pair" here is just a chunk of two consecutive messages. With well-
    // formed alternating user/assistant chat history this gives true
    // user->assistant turn pairs. With unbalanced history (last user turn
    // unanswered, interleaved system notes filtered upstream) we still end
    // up with sensible 2-message buckets. The count is what matters for
    // "keep last N pairs" math, not the exact roles inside each bucket.
    const pairs: ChatMessage[][] = [];
    for (let i = 0; i < messages.length; i += 2) {
      pairs.push(messages.slice(i, i + 2));
    }
    return pairs;
  }
}

function toLLMMessage(m: ChatMessage): LLMMessage {
  return { role: m.role, content: m.content };
}
