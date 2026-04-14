import type { OperationId } from "@core/types";

// Per-session accumulator for token usage and cost.
//
// Cost is NOT recomputed here — pi-ai already returns the per-call cost in its
// final usage payload (using the price table baked into its model registry, or
// zero for free providers like Ollama). The tracker just sums what pi-ai
// reports so the UI can show "this session has used X tokens / $Y so far."

export interface TokenRecord {
  operationId: OperationId | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface SessionTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
}

export class TokenTracker {
  private records = new Map<string, TokenRecord[]>();

  record(sessionId: string, entry: TokenRecord): void {
    const existing = this.records.get(sessionId) ?? [];
    existing.push(entry);
    this.records.set(sessionId, existing);
  }

  getSessionRecords(sessionId: string): TokenRecord[] {
    return [...(this.records.get(sessionId) ?? [])];
  }

  getSessionTotals(sessionId: string): SessionTotals {
    const records = this.records.get(sessionId) ?? [];
    return records.reduce<SessionTotals>(
      (acc, r) => ({
        totalInputTokens: acc.totalInputTokens + r.inputTokens,
        totalOutputTokens: acc.totalOutputTokens + r.outputTokens,
        totalCostUsd: acc.totalCostUsd + r.costUsd,
        callCount: acc.callCount + 1,
      }),
      {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
      },
    );
  }

  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      this.records.clear();
    } else {
      this.records.delete(sessionId);
    }
  }
}
