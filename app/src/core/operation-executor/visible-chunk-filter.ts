// A stream filter that forwards the "visible" prefix of an LLM response
// (the part before a `<generation_context>` or `<change_context>` tag)
// and drops everything from the tag onward.
//
// The LLM output in Phase 1 / Phase 2.7a has the shape:
//
//   <visible response — 1-2 sentences of chat>
//
//   <generation_context>
//     ...YAML...
//   </generation_context>
//
// We stream `onStreamChunk` deltas to the client as they arrive. Without
// filtering, the user sees the `<generation_context>` block being typed
// out character by character in the chat bubble, which is ugly and
// defeats the "structured data is hidden" contract.
//
// Challenge: a delta may straddle the tag boundary — e.g. "<" arrives in
// one chunk and "generation_context>" in another. We buffer accumulated
// text and only forward the portion that is safely before any possible
// tag match.

const STOP_TAGS = ["<generation_context>", "<change_context>"] as const;
const MAX_TAG_LEN = Math.max(...STOP_TAGS.map((t) => t.length));

export interface VisibleChunkFilter {
  /** Feed a new streaming delta from the LLM. */
  push(chunk: string): void;
  /**
   * Called once after the stream finishes. If we never encountered a
   * stop tag (clarifying question path), flushes any held-back tail so
   * the final forwarded text matches the LLM's full visible response.
   */
  flush(): void;
  /** Full accumulated raw text, for debugging / tests. */
  getAccumulated(): string;
  /** Whether a stop tag was seen. */
  wasStopped(): boolean;
}

export function createVisibleChunkFilter(
  forward: (chunk: string) => void,
): VisibleChunkFilter {
  let accumulated = "";
  let emitted = 0;
  let stopped = false;

  return {
    push(chunk: string): void {
      // Always accumulate — the raw text is still used by the parser
      // downstream. Only forwarding is gated by the stopped flag.
      accumulated += chunk;
      if (stopped) return;

      // Find the earliest occurrence of any stop tag.
      let tagAt = -1;
      for (const tag of STOP_TAGS) {
        const idx = accumulated.indexOf(tag, emitted);
        if (idx !== -1 && (tagAt === -1 || idx < tagAt)) tagAt = idx;
      }

      if (tagAt !== -1) {
        // Emit up to the tag, then stop forwarding.
        if (tagAt > emitted) {
          forward(accumulated.slice(emitted, tagAt));
          emitted = tagAt;
        }
        stopped = true;
        return;
      }

      // No tag yet — forward everything except the "uncertain tail" (the
      // last MAX_TAG_LEN chars could be the start of a tag split across
      // chunks). Keeps worst-case lag at one full tag length.
      const safeEnd = accumulated.length - MAX_TAG_LEN;
      if (safeEnd > emitted) {
        forward(accumulated.slice(emitted, safeEnd));
        emitted = safeEnd;
      }
    },

    flush(): void {
      if (stopped) return;
      // Stream ended without a tag — flush the tail we've been holding.
      if (accumulated.length > emitted) {
        forward(accumulated.slice(emitted));
        emitted = accumulated.length;
      }
    },

    getAccumulated(): string {
      return accumulated;
    },

    wasStopped(): boolean {
      return stopped;
    },
  };
}
