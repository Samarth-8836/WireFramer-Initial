import { describe, expect, it } from "vitest";

import type { OperationDefinition, ParseResult } from "@core/types";

import { OperationExecutor } from "../executor";

// These tests bypass pi-ai entirely by subclassing OperationExecutor and
// overriding the protected streamCall hook with a deterministic fake.
//
// Why a subclass instead of vi.spyOn? Because we want compile-time access to
// the protected method, not a runtime-only escape hatch — that way the tests
// keep working after refactors instead of silently no-op'ing if the method
// is renamed.

interface StubResponse {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorMessage: string | null;
}

class StubExecutor extends OperationExecutor {
  public callCount = 0;
  public lastMessages: unknown[] | null = null;
  constructor(private readonly responses: StubResponse[]) {
    super();
  }

  // Relaxed signature for test-only override; the runtime contract matches
  // the parent's streamCall — accept an args object with a `context` shape
  // and return a StubResponse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async streamCall(args: any): Promise<StubResponse> {
    this.lastMessages = args.context.messages as unknown[];
    const idx = Math.min(this.callCount, this.responses.length - 1);
    this.callCount += 1;
    return this.responses[idx];
  }
}

function defStub<T>(
  parser: (raw: string) => ParseResult<T>,
  overrides: Partial<OperationDefinition<T>> = {},
): OperationDefinition<T> {
  return {
    operationId: "op-1-0",
    systemPrompt: "system",
    messages: [{ role: "user", content: "user" }],
    expectedOutputFormat: "plain_text",
    outputParser: parser,
    maxRetries: 1,
    retryPrompt: "try again",
    timeoutMs: 5_000,
    role: "fast",
    ...overrides,
  };
}

describe("OperationExecutor (unit)", () => {
  it("returns success on first parse hit", async () => {
    const exec = new StubExecutor([
      {
        fullText: "ok",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        errorMessage: null,
      },
    ]);

    const result = await exec.execute(
      defStub<{ text: string }>((raw) => ({
        success: true,
        data: { text: raw },
        rawText: raw,
      })),
    );

    expect(result.status).toBe("success");
    expect(exec.callCount).toBe(1);
    expect(result.tokenUsage).toEqual({ input: 10, output: 5 });
    expect(result.cost).toBe(0.01);
  });

  it("retries on parse failure and succeeds on the second attempt", async () => {
    const exec = new StubExecutor([
      {
        fullText: "first try",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        errorMessage: null,
      },
      {
        fullText: "second try",
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.01,
        errorMessage: null,
      },
    ]);

    let calls = 0;
    const parser = (raw: string): ParseResult<{ text: string }> => {
      calls += 1;
      if (calls === 1) {
        return { success: false, error: "first parse fail", rawText: raw };
      }
      return { success: true, data: { text: raw }, rawText: raw };
    };

    const result = await exec.execute(defStub(parser));

    expect(result.status).toBe("success");
    expect(exec.callCount).toBe(2);
    // Token counts accumulate across attempts.
    expect(result.tokenUsage.input).toBe(22);
    expect(result.tokenUsage.output).toBe(11);
    expect(result.cost).toBeCloseTo(0.02);
  });

  it("retry message context includes the failed assistant turn and parse error", async () => {
    const exec = new StubExecutor([
      {
        fullText: "broken first response",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        errorMessage: null,
      },
      {
        fullText: "fixed",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        errorMessage: null,
      },
    ]);

    let calls = 0;
    const parser = (raw: string): ParseResult => {
      calls += 1;
      if (calls === 1) {
        return {
          success: false,
          error: "expected JSON, got prose",
          rawText: raw,
        };
      }
      return { success: true, data: { ok: true }, rawText: raw };
    };

    await exec.execute(defStub(parser));

    // After both calls, the second context should include: original user
    // message + assistant turn (failed output) + corrective user turn.
    expect(exec.lastMessages).not.toBeNull();
    expect(exec.lastMessages!.length).toBeGreaterThanOrEqual(3);
    const corrective = JSON.stringify(exec.lastMessages);
    expect(corrective).toContain("broken first response");
    expect(corrective).toContain("expected JSON, got prose");
  });

  it("exhausts retries and returns OperationResult.failed", async () => {
    const exec = new StubExecutor([
      {
        fullText: "junk one",
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0,
        errorMessage: null,
      },
      {
        fullText: "junk two",
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0,
        errorMessage: null,
      },
    ]);

    const parser = (raw: string): ParseResult => ({
      success: false,
      error: "always fails",
      rawText: raw,
    });

    const result = await exec.execute(defStub(parser, { maxRetries: 1 }));

    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(result.error).toBe("always fails");
    expect(exec.callCount).toBe(2);
    expect(result.tokenUsage.input).toBe(10);
  });

  it("does not retry when retryPrompt is null", async () => {
    const exec = new StubExecutor([
      {
        fullText: "junk",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        errorMessage: null,
      },
      {
        fullText: "should-not-be-reached",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        errorMessage: null,
      },
    ]);

    const parser = (raw: string): ParseResult => ({
      success: false,
      error: "nope",
      rawText: raw,
    });

    const result = await exec.execute(
      defStub(parser, { maxRetries: 5, retryPrompt: null }),
    );

    expect(result.status).toBe("failed");
    expect(exec.callCount).toBe(1);
  });

  it("surfaces transport errors immediately without retrying", async () => {
    const exec = new StubExecutor([
      {
        fullText: "",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        errorMessage: "auth failure",
      },
      {
        fullText: "should-not-be-reached",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        errorMessage: null,
      },
    ]);

    const parser = (raw: string): ParseResult => ({
      success: true,
      data: { ok: true },
      rawText: raw,
    });

    const result = await exec.execute(defStub(parser, { maxRetries: 3 }));

    expect(result.status).toBe("failed");
    expect(result.error).toBe("auth failure");
    expect(exec.callCount).toBe(1);
  });

  it("records tokens against the session when sessionId is provided", async () => {
    const exec = new StubExecutor([
      {
        fullText: "ok",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        errorMessage: null,
      },
    ]);

    const parser = (raw: string): ParseResult => ({
      success: true,
      data: { text: raw },
      rawText: raw,
    });

    await exec.execute(defStub(parser), { sessionId: "test-session" });

    const totals = exec.getTokenTracker().getSessionTotals("test-session");
    expect(totals.callCount).toBe(1);
    expect(totals.totalInputTokens).toBe(100);
    expect(totals.totalOutputTokens).toBe(50);
    expect(totals.totalCostUsd).toBeCloseTo(0.001);
  });

  it("does not record tokens when sessionId is omitted", async () => {
    const exec = new StubExecutor([
      {
        fullText: "ok",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0,
        errorMessage: null,
      },
    ]);

    const parser = (raw: string): ParseResult => ({
      success: true,
      data: { text: raw },
      rawText: raw,
    });

    await exec.execute(defStub(parser));

    const totals = exec.getTokenTracker().getSessionTotals("any-session");
    expect(totals.callCount).toBe(0);
  });
});
