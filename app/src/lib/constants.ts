// Default executor knobs. The plan's spec puts these here so any tuning lives
// in one place rather than getting buried inside operations.

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_BATCH_CONCURRENCY = 3;

// Context budgets (Sprint 3 will start consuming these).
export const CHAT_HISTORY_TOKEN_BUDGET = 4_000;
export const RECENT_MESSAGE_PAIRS_TO_KEEP = 5;

// Sprint 8 toggle for stale-test detection.
export const STALE_TEST_CHECK_ENABLED = true;
