import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";

import { Summarizer } from "../summarizer";
import {
  FailingExecutor,
  FakeExecutor,
  makeChat,
} from "./test-helpers";

describe("Summarizer.processHistory", () => {
  it("returns an empty list when given no messages", async () => {
    const executor = new FakeExecutor("unused");
    const summarizer = new Summarizer(executor);

    const result = await summarizer.processHistory([], 4_000);

    expect(result).toEqual([]);
    expect(executor.callCount).toBe(0);
  });

  it("returns messages as-is when under budget and does NOT call the executor", async () => {
    const executor = new FakeExecutor("should-not-be-used");
    const summarizer = new Summarizer(executor);

    const messages = [
      makeChat(1, "s1", "phase-1", "user", "hi"),
      makeChat(2, "s1", "phase-1", "assistant", "hello"),
      makeChat(3, "s1", "phase-1", "user", "what next?"),
    ];

    const result = await summarizer.processHistory(messages, 4_000);

    expect(executor.callCount).toBe(0);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "hi" });
    expect(result[1]).toEqual({ role: "assistant", content: "hello" });
    expect(result[2]).toEqual({ role: "user", content: "what next?" });
  });

  it("summarizes older pairs and keeps the 5 most recent pairs verbatim when over budget", async () => {
    const executor = new FakeExecutor("SUMMARY_OF_OLDER");
    const summarizer = new Summarizer(executor);

    // Each message ~2000 chars => ~500 tokens. 16 messages => ~8000 tokens,
    // well above the 4000 token budget, which forces the summarize path.
    const bigContent = "x".repeat(2000);
    const messages = Array.from({ length: 16 }, (_, i) =>
      makeChat(
        i,
        "s1",
        "phase-1",
        i % 2 === 0 ? "user" : "assistant",
        `${bigContent}-${i}`,
      ),
    );

    const result = await summarizer.processHistory(messages, 4_000);

    expect(executor.callCount).toBe(1);
    // 16 messages -> 8 pairs. Keep last 5 pairs = 10 messages. Plus the
    // summary system message prepended: 11 total.
    expect(result).toHaveLength(11);
    expect(result[0]).toEqual({
      role: "system",
      content: "Previous conversation summary:\nSUMMARY_OF_OLDER",
    });
    // The first recent message should be message index 6 (the 7th msg,
    // start of the 4th pair — last 5 pairs = indices 6..15).
    expect(result[1].content).toContain("-6");
    expect(result[result.length - 1].content).toContain("-15");
  });

  it("returns messages as-is when pair count <= RECENT_MESSAGE_PAIRS_TO_KEEP even if over budget", async () => {
    // With only 4 pairs (8 messages) there's nothing "older" to summarize —
    // we'd be handing the LLM the same messages it would have seen anyway.
    // The summarizer takes the honest path: return them and let the caller
    // decide how to handle the overflow.
    const executor = new FakeExecutor("should-not-be-used");
    const summarizer = new Summarizer(executor);

    const bigContent = "x".repeat(3000);
    const messages = Array.from({ length: 8 }, (_, i) =>
      makeChat(
        i,
        "s1",
        "phase-1",
        i % 2 === 0 ? "user" : "assistant",
        `${bigContent}-${i}`,
      ),
    );

    const result = await summarizer.processHistory(messages, 100);

    expect(executor.callCount).toBe(0);
    expect(result).toHaveLength(8);
  });

  it("falls back to a truncated concatenation when the summarizing executor fails", async () => {
    const executor = new FailingExecutor();
    const summarizer = new Summarizer(executor);

    const bigContent = "x".repeat(2000);
    const messages = Array.from({ length: 16 }, (_, i) =>
      makeChat(
        i,
        "s1",
        "phase-1",
        i % 2 === 0 ? "user" : "assistant",
        `${bigContent}-${i}`,
      ),
    );

    const result = await summarizer.processHistory(messages, 4_000);

    expect(executor.callCount).toBe(1);
    // First element is the fallback summary system message.
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Previous conversation summary:");
    // The fallback ends with an ellipsis because the concatenated older
    // content is far longer than the 500-char cap.
    expect(result[0].content).toMatch(/\.\.\.$/);
  });

  it("sends the concatenated older conversation to the executor with role=fast", async () => {
    const executor = new FakeExecutor("ok");
    const summarizer = new Summarizer(executor);

    const bigContent = "x".repeat(2000);
    const messages = Array.from({ length: 14 }, (_, i) =>
      makeChat(
        i,
        "s1",
        "phase-1",
        i % 2 === 0 ? "user" : "assistant",
        `${bigContent}-${i}`,
      ),
    );

    await summarizer.processHistory(messages, 4_000);

    const def = executor.lastDefinition;
    expect(def).not.toBeNull();
    expect(def!.role).toBe("fast");
    expect(def!.expectedOutputFormat).toBe("plain_text");
    // Summarizer should have sent the OLDER messages to the executor,
    // not the recent ones. 14 -> 7 pairs. Keep last 5 pairs = indices
    // 4..13. Older pairs = indices 0..3, which is 4 messages.
    const sentBody = def!.messages[0].content;
    expect(sentBody).toContain("-0");
    expect(sentBody).toContain("-3");
    expect(sentBody).not.toContain("-13");
  });
});

describe("Summarizer.updateConversationSummary", () => {
  it("creates a new entry when none exists", async () => {
    const storage = new MemoryStorage();
    const summarizer = new Summarizer(new FakeExecutor("unused"));

    await summarizer.updateConversationSummary(
      storage,
      "sess-1",
      "phase-2",
      1,
      "Added login screen",
      "screen-level",
      ["screen-001", "wf-002"],
    );

    const saved = await storage.getConversationSummary("sess-1", "phase-2");
    expect(saved).not.toBeNull();
    expect(saved!.summary).toBe(
      "Iteration 1: Added login screen [scope: screen-level, affected: screen-001, wf-002]",
    );
    expect(saved!.messagesCovered).toBe(1);
    expect(saved!.sessionId).toBe("sess-1");
    expect(saved!.phaseId).toBe("phase-2");
  });

  it("appends to an existing entry and increments messagesCovered", async () => {
    const storage = new MemoryStorage();
    const summarizer = new Summarizer(new FakeExecutor("unused"));

    await summarizer.updateConversationSummary(
      storage,
      "sess-2",
      "phase-2",
      1,
      "First change",
      "workflow-level",
      ["wf-001"],
    );
    await summarizer.updateConversationSummary(
      storage,
      "sess-2",
      "phase-2",
      2,
      "Second change",
      "screen-level",
      ["screen-003"],
    );

    const saved = await storage.getConversationSummary("sess-2", "phase-2");
    expect(saved).not.toBeNull();
    const lines = saved!.summary.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Iteration 1: First change");
    expect(lines[1]).toContain("Iteration 2: Second change");
    expect(saved!.messagesCovered).toBe(2);
  });
});
