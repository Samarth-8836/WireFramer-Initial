// Per-operation model routing. Later sprints use this to pick which role
// each op runs under. Kept here so config.ts stays the single source of truth.
export interface ModelConfig {
  defaultFastRole: "fast";
  defaultReasoningRole: "reasoning";
}

export interface AppConfig {
  models: ModelConfig;
  storage: {
    type: "file" | "memory";
    dataDir: string;
  };
  executor: {
    maxConcurrentBatchCalls: number;
    defaultTimeoutMs: number;
    defaultMaxRetries: number;
  };
  contextBuilder: {
    chatHistoryTokenBudget: number;
    recentMessagePairsToKeep: number;
  };
}
