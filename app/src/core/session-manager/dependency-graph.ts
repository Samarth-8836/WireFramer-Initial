import type { OperationStatus } from "@core/types";
import { DEFAULT_BATCH_CONCURRENCY } from "@lib/constants";

// Directed-acyclic-graph executor for multi-operation flows.
//
// Two flows use this: (1) the Phase 2 auto-generation chain — 20+ ops with
// a fixed topology — and (2) iteration cascades, where a user change in
// Phase 2 triggers a sub-graph of dependent updates.
//
// Design goals:
//   1. Respect dependency order. A node runs only after all its
//      dependencies have completed (or have been skipped via condition).
//   2. Exploit parallelism. Independent ready nodes run simultaneously,
//      up to `maxConcurrency`.
//   3. Allow conditional skips. A node with a `condition` function gets
//      queried before execution — `false` marks it `skipped`, and
//      downstream nodes treat that as "dependency satisfied".
//   4. Survive partial failures where the still-reachable subgraph can
//      make progress. A failed node marks downstream nodes unreachable,
//      but siblings and their downstreams continue.
//   5. Report progress via an `onProgress` callback so the session manager
//      can stream per-op status events to the UI.
//
// Non-goals:
//   - Retry. Each node is expected to manage its own retries internally
//     (Operation Executor already does this per-op).
//   - Durability. The executor state is in-memory. Session Manager
//     persists final outcomes to storage after each batch.

export interface GraphNode {
  operationId: string;
  dependencies: string[];
  // Pre-execution gate. If returns false, the node transitions to
  // `skipped` (not `failed`) and downstream nodes treat the dep as met.
  condition?: () => Promise<boolean>;
  execute: () => Promise<void>;
}

export type ProgressCallback = (
  operationId: string,
  status: OperationStatus,
) => void;

export interface DependencyGraphOptions {
  maxConcurrency?: number;
  onProgress?: ProgressCallback;
}

export class DependencyGraphExecutor {
  private readonly statuses = new Map<string, OperationStatus>();
  private readonly errors = new Map<string, Error>();
  private readonly maxConcurrency: number;
  private readonly onProgress?: ProgressCallback;

  constructor(options: DependencyGraphOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_BATCH_CONCURRENCY;
    this.onProgress = options.onProgress;
  }

  async execute(nodes: GraphNode[]): Promise<Map<string, OperationStatus>> {
    // Fresh run — reset any prior state.
    this.statuses.clear();
    this.errors.clear();

    if (nodes.length === 0) return this.statuses;

    this.validateGraph(nodes);

    const byId = new Map(nodes.map((n) => [n.operationId, n]));
    for (const node of nodes) {
      this.setStatus(node.operationId, "not_started");
    }

    // Track in-flight work so we can wait for them without polling storage.
    const running = new Map<string, Promise<void>>();

    while (true) {
      // 1. Collect all nodes that are ready. A node is ready when every
      //    dependency is in a terminal state (complete OR skipped) AND
      //    the node itself is still not_started.
      const ready: GraphNode[] = [];
      for (const node of nodes) {
        if (this.statuses.get(node.operationId) !== "not_started") continue;
        if (!this.depsReady(node)) continue;
        ready.push(node);
      }

      if (ready.length === 0) {
        // No nodes to start. Either we're done, or waiting on in-flight
        // work to unblock more.
        if (running.size === 0) break;
        // Wait for the next in-flight task to settle before re-checking
        // readiness. `Promise.race` + a lookup on the running map gives us
        // a tight loop with no polling timer.
        await Promise.race(running.values()).catch(() => {
          /* swallow — errors already recorded in this.errors */
        });
        continue;
      }

      // 2. Evaluate conditions for each ready node. A false condition
      //    skips the node and lets downstream deps advance. Conditions
      //    run sequentially (cheap predicate calls, and doing them one
      //    at a time keeps the progress log in a natural order).
      const toRun: GraphNode[] = [];
      for (const node of ready) {
        if (node.condition) {
          const shouldRun = await node.condition();
          if (!shouldRun) {
            this.setStatus(node.operationId, "skipped");
            continue;
          }
        }
        toRun.push(node);
      }

      if (toRun.length === 0) {
        // All ready nodes skipped. Loop again to re-collect freshly ready
        // nodes — skipped nodes unblock their downstreams.
        continue;
      }

      // 3. Start as many as the concurrency budget allows. If more than
      //    `maxConcurrency - running.size` nodes are ready, the rest will
      //    get picked up on the next iteration.
      const budget = Math.max(0, this.maxConcurrency - running.size);
      const batch = toRun.slice(0, budget);

      for (const node of batch) {
        this.setStatus(node.operationId, "in_progress");
        const promise = this.runNode(node).finally(() => {
          running.delete(node.operationId);
        });
        running.set(node.operationId, promise);
      }

      // 4. If nothing was started (concurrency budget zero) we have to
      //    wait for an in-flight task to finish. Otherwise, loop and
      //    re-check readiness immediately — there may be more ready nodes
      //    beyond the budget, and finished nodes may have unblocked
      //    more downstreams.
      if (batch.length === 0 && running.size > 0) {
        await Promise.race(running.values()).catch(() => {
          /* swallow */
        });
      }
    }

    // 5. Anything still marked not_started at the end is unreachable —
    //    some upstream ancestor failed and broke every path. Mark it as
    //    skipped so the final status map has no ambiguous entries.
    // Use `byId` only as a completeness check; no mutation beyond statuses.
    for (const [id, status] of this.statuses.entries()) {
      if (status === "not_started") {
        this.setStatus(id, "skipped");
      }
    }
    // Silence the "byId unused" lint if no unreachables were found.
    void byId;

    return this.statuses;
  }

  getStatuses(): Map<string, OperationStatus> {
    return this.statuses;
  }

  getErrors(): Map<string, Error> {
    return this.errors;
  }

  private async runNode(node: GraphNode): Promise<void> {
    try {
      await node.execute();
      this.setStatus(node.operationId, "complete");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errors.set(node.operationId, error);
      this.setStatus(node.operationId, "failed");
    }
  }

  private depsReady(node: GraphNode): boolean {
    for (const dep of node.dependencies) {
      const s = this.statuses.get(dep);
      // A dependency is "satisfied" if it completed OR was skipped. A
      // skipped dep is treated as a no-op success — the downstream node
      // is still free to run. If the dep failed or is still pending, the
      // node is NOT ready; a failed dep may never satisfy, in which case
      // the post-loop unreachable sweep will mark this node skipped.
      if (s !== "complete" && s !== "skipped") return false;
    }
    return true;
  }

  private setStatus(id: string, status: OperationStatus): void {
    const previous = this.statuses.get(id);
    if (previous === status) return;
    this.statuses.set(id, status);
    this.onProgress?.(id, status);
  }

  private validateGraph(nodes: GraphNode[]): void {
    const ids = new Set(nodes.map((n) => n.operationId));

    // Duplicate ids would make dependency resolution ambiguous.
    if (ids.size !== nodes.length) {
      throw new Error("Dependency graph contains duplicate operationIds");
    }

    // Every referenced dependency must exist in the graph.
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        if (!ids.has(dep)) {
          throw new Error(
            `Node ${node.operationId} depends on unknown operation ${dep}`,
          );
        }
      }
    }

    // Cycle detection — DFS with a recursion stack. O(V+E).
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const n of nodes) color.set(n.operationId, WHITE);

    const byId = new Map(nodes.map((n) => [n.operationId, n]));
    const dfs = (id: string): void => {
      const c = color.get(id);
      if (c === GRAY) {
        throw new Error(
          `Dependency graph has a cycle involving ${id}`,
        );
      }
      if (c === BLACK) return;
      color.set(id, GRAY);
      const node = byId.get(id);
      if (node) {
        for (const dep of node.dependencies) dfs(dep);
      }
      color.set(id, BLACK);
    };
    for (const node of nodes) dfs(node.operationId);
  }
}
