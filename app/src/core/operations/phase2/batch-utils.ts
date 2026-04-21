// Semaphore-based batch execution for parallel AI operations.
//
// Used by ops 2.1b (workflow detail), 2.2a (test case gen), 2.4c (screen HTML),
// and 2.5b (test translation). Each of these is "one LLM call per item" with
// a concurrency cap to avoid rate limits.

import { DEFAULT_BATCH_CONCURRENCY } from "@lib/constants";

export interface BatchResult<T> {
  succeeded: { item: T; result: unknown }[];
  failed: { item: T; error: string }[];
}

export async function executeBatch<T>(
  items: T[],
  executor: (item: T) => Promise<unknown>,
  maxConcurrency: number = DEFAULT_BATCH_CONCURRENCY,
): Promise<BatchResult<T>> {
  const succeeded: { item: T; result: unknown }[] = [];
  const failed: { item: T; error: string }[] = [];

  // Simple semaphore via a counter + queue of resolvers.
  let active = 0;
  const waiting: (() => void)[] = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }

  function release(): void {
    if (waiting.length > 0) {
      const next = waiting.shift()!;
      next();
    } else {
      active--;
    }
  }

  await Promise.allSettled(
    items.map(async (item) => {
      await acquire();
      try {
        const result = await executor(item);
        succeeded.push({ item, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ item, error: msg });
      } finally {
        release();
      }
    }),
  );

  return { succeeded, failed };
}
