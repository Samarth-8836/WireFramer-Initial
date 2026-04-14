import { describe, expect, it } from "vitest";

import type { OperationStatus } from "@core/types";

import {
  DependencyGraphExecutor,
  type GraphNode,
} from "../dependency-graph";

// Helper that builds a node wrapping a simple async function. Records
// the order of execution into the provided array.
function op(
  id: string,
  deps: string[],
  order: string[],
  impl: () => Promise<void> = async () => {},
): GraphNode {
  return {
    operationId: id,
    dependencies: deps,
    execute: async () => {
      await impl();
      order.push(id);
    },
  };
}

describe("DependencyGraphExecutor — core execution", () => {
  it("returns an empty status map for an empty graph", async () => {
    const exec = new DependencyGraphExecutor();
    const result = await exec.execute([]);
    expect(result.size).toBe(0);
  });

  it("executes linear A -> B -> C in order", async () => {
    const order: string[] = [];
    const exec = new DependencyGraphExecutor();
    const nodes: GraphNode[] = [
      op("A", [], order),
      op("B", ["A"], order),
      op("C", ["B"], order),
    ];

    const result = await exec.execute(nodes);

    expect(order).toEqual(["A", "B", "C"]);
    expect(result.get("A")).toBe<OperationStatus>("complete");
    expect(result.get("B")).toBe<OperationStatus>("complete");
    expect(result.get("C")).toBe<OperationStatus>("complete");
  });

  it("runs parallel siblings simultaneously up to the concurrency cap", async () => {
    // B and C both depend on A and are independent of each other. They
    // should both be in-flight at the same moment. We detect overlap by
    // counting concurrent active calls.
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const slowOp = (id: string, deps: string[]): GraphNode => ({
      operationId: id,
      dependencies: deps,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        order.push(id);
      },
    });

    const exec = new DependencyGraphExecutor({ maxConcurrency: 4 });
    const result = await exec.execute([
      slowOp("A", []),
      slowOp("B", ["A"]),
      slowOp("C", ["A"]),
      slowOp("D", ["B", "C"]),
    ]);

    expect(result.get("D")).toBe<OperationStatus>("complete");
    // A must be first. D must be last. Order of B/C is indeterminate.
    expect(order[0]).toBe("A");
    expect(order[3]).toBe("D");
    expect(maxActive).toBeGreaterThanOrEqual(2); // B and C overlapped
  });

  it("honors maxConcurrency by staggering beyond the cap", async () => {
    let active = 0;
    let maxActive = 0;
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push({
        operationId: `N${i}`,
        dependencies: [],
        execute: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
        },
      });
    }
    const exec = new DependencyGraphExecutor({ maxConcurrency: 2 });
    await exec.execute(nodes);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("skips conditional nodes when condition returns false and still runs downstream", async () => {
    const order: string[] = [];
    const exec = new DependencyGraphExecutor();
    const nodes: GraphNode[] = [
      op("A", [], order),
      {
        operationId: "B",
        dependencies: ["A"],
        condition: async () => false,
        execute: async () => {
          order.push("B");
        },
      },
      op("C", ["B"], order),
    ];

    const result = await exec.execute(nodes);

    expect(order).toEqual(["A", "C"]);
    expect(result.get("A")).toBe<OperationStatus>("complete");
    expect(result.get("B")).toBe<OperationStatus>("skipped");
    expect(result.get("C")).toBe<OperationStatus>("complete");
  });

  it("runs conditional nodes when condition returns true", async () => {
    const order: string[] = [];
    const exec = new DependencyGraphExecutor();
    const nodes: GraphNode[] = [
      op("A", [], order),
      {
        operationId: "B",
        dependencies: ["A"],
        condition: async () => true,
        execute: async () => {
          order.push("B");
        },
      },
    ];
    await exec.execute(nodes);
    expect(order).toEqual(["A", "B"]);
  });
});

describe("DependencyGraphExecutor — failure handling", () => {
  it("marks a failing node as failed and its downstream as skipped", async () => {
    const order: string[] = [];
    const exec = new DependencyGraphExecutor();
    const nodes: GraphNode[] = [
      op("A", [], order),
      {
        operationId: "B",
        dependencies: ["A"],
        execute: async () => {
          throw new Error("boom");
        },
      },
      op("C", ["B"], order),
    ];

    const result = await exec.execute(nodes);

    expect(result.get("A")).toBe<OperationStatus>("complete");
    expect(result.get("B")).toBe<OperationStatus>("failed");
    // C depended on B which failed, so C is unreachable and marked skipped.
    expect(result.get("C")).toBe<OperationStatus>("skipped");
    expect(order).toEqual(["A"]);

    const errors = exec.getErrors();
    expect(errors.get("B")?.message).toBe("boom");
  });

  it("lets surviving branches continue when one sibling fails", async () => {
    // Graph:  A -> (B fails, C succeeds) -> D depends only on C.
    // D should still run because its only dep (C) completed successfully.
    const order: string[] = [];
    const exec = new DependencyGraphExecutor();
    const nodes: GraphNode[] = [
      op("A", [], order),
      {
        operationId: "B",
        dependencies: ["A"],
        execute: async () => {
          throw new Error("nope");
        },
      },
      op("C", ["A"], order),
      op("D", ["C"], order),
    ];

    const result = await exec.execute(nodes);
    expect(result.get("A")).toBe<OperationStatus>("complete");
    expect(result.get("B")).toBe<OperationStatus>("failed");
    expect(result.get("C")).toBe<OperationStatus>("complete");
    expect(result.get("D")).toBe<OperationStatus>("complete");
    expect(order).toEqual(["A", "C", "D"]);
  });
});

describe("DependencyGraphExecutor — progress callback", () => {
  it("fires onProgress for every status transition in order", async () => {
    const log: Array<[string, OperationStatus]> = [];
    const exec = new DependencyGraphExecutor({
      onProgress: (id, s) => log.push([id, s]),
    });
    const nodes: GraphNode[] = [
      op("A", [], []),
      op("B", ["A"], []),
    ];
    await exec.execute(nodes);

    // Expected sequence: A not_started, B not_started, A in_progress,
    // A complete, B in_progress, B complete.
    expect(log[0]).toEqual(["A", "not_started"]);
    expect(log[1]).toEqual(["B", "not_started"]);
    expect(log[2]).toEqual(["A", "in_progress"]);
    expect(log[3]).toEqual(["A", "complete"]);
    expect(log[4]).toEqual(["B", "in_progress"]);
    expect(log[5]).toEqual(["B", "complete"]);
  });
});

describe("DependencyGraphExecutor — validation", () => {
  it("throws on duplicate operationIds", async () => {
    const exec = new DependencyGraphExecutor();
    await expect(
      exec.execute([
        { operationId: "A", dependencies: [], execute: async () => {} },
        { operationId: "A", dependencies: [], execute: async () => {} },
      ]),
    ).rejects.toThrow(/duplicate operationIds/);
  });

  it("throws on references to unknown dependencies", async () => {
    const exec = new DependencyGraphExecutor();
    await expect(
      exec.execute([
        {
          operationId: "A",
          dependencies: ["missing"],
          execute: async () => {},
        },
      ]),
    ).rejects.toThrow(/unknown operation missing/);
  });

  it("throws on cycles", async () => {
    const exec = new DependencyGraphExecutor();
    await expect(
      exec.execute([
        { operationId: "A", dependencies: ["B"], execute: async () => {} },
        { operationId: "B", dependencies: ["A"], execute: async () => {} },
      ]),
    ).rejects.toThrow(/cycle/);
  });
});
