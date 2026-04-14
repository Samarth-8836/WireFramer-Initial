import { describe, expect, it } from "vitest";

import { TokenTracker } from "../token-tracker";

function record(overrides = {}) {
  return {
    operationId: "op-1-0",
    provider: "ollama",
    model: "qwen3.5:4b",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("TokenTracker", () => {
  it("starts empty", () => {
    const t = new TokenTracker();
    const totals = t.getSessionTotals("session-1");
    expect(totals.totalInputTokens).toBe(0);
    expect(totals.totalOutputTokens).toBe(0);
    expect(totals.totalCostUsd).toBe(0);
    expect(totals.callCount).toBe(0);
  });

  it("accumulates per session", () => {
    const t = new TokenTracker();
    t.record("session-1", record());
    t.record(
      "session-1",
      record({ inputTokens: 200, outputTokens: 75, costUsd: 0.005 }),
    );
    const totals = t.getSessionTotals("session-1");
    expect(totals.totalInputTokens).toBe(300);
    expect(totals.totalOutputTokens).toBe(125);
    expect(totals.totalCostUsd).toBeCloseTo(0.005);
    expect(totals.callCount).toBe(2);
  });

  it("isolates sessions", () => {
    const t = new TokenTracker();
    t.record("session-a", record({ inputTokens: 100 }));
    t.record("session-b", record({ inputTokens: 999 }));
    expect(t.getSessionTotals("session-a").totalInputTokens).toBe(100);
    expect(t.getSessionTotals("session-b").totalInputTokens).toBe(999);
  });

  it("reset(sessionId) clears one session only", () => {
    const t = new TokenTracker();
    t.record("session-a", record());
    t.record("session-b", record());
    t.reset("session-a");
    expect(t.getSessionTotals("session-a").callCount).toBe(0);
    expect(t.getSessionTotals("session-b").callCount).toBe(1);
  });

  it("reset() clears everything", () => {
    const t = new TokenTracker();
    t.record("session-a", record());
    t.record("session-b", record());
    t.reset();
    expect(t.getSessionTotals("session-a").callCount).toBe(0);
    expect(t.getSessionTotals("session-b").callCount).toBe(0);
  });

  it("getSessionRecords returns a copy", () => {
    const t = new TokenTracker();
    t.record("s", record());
    const records = t.getSessionRecords("s");
    records.push(record({ inputTokens: 99999 }));
    expect(t.getSessionTotals("s").totalInputTokens).toBe(100); // unchanged
  });
});
