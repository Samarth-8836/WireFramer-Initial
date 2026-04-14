import { describe, expect, it } from "vitest";

import { DependencyGraphExecutor } from "../dependency-graph";
import {
  AUTO_GEN_OPERATION_IDS,
  buildAutoGenerationGraph,
  type AutoGenConditions,
  type AutoGenRunners,
} from "../auto-generation-graph";

function stubRunners(order: string[]): AutoGenRunners {
  const runners = {} as AutoGenRunners;
  for (const id of AUTO_GEN_OPERATION_IDS) {
    runners[id] = async () => {
      order.push(id);
    };
  }
  return runners;
}

function allTrueConditions(): AutoGenConditions {
  return {
    "op-2-3c": async () => true,
    "op-2-5e": async () => true,
  };
}

describe("buildAutoGenerationGraph", () => {
  it("produces a node for every auto-gen operation id", () => {
    const order: string[] = [];
    const graph = buildAutoGenerationGraph(
      stubRunners(order),
      allTrueConditions(),
    );
    const ids = graph.map((n) => n.operationId).sort();
    const expected = [...AUTO_GEN_OPERATION_IDS].sort();
    expect(ids).toEqual(expected);
  });

  it("runs the full graph in a topologically valid order with all conditions true", async () => {
    const order: string[] = [];
    const graph = buildAutoGenerationGraph(
      stubRunners(order),
      allTrueConditions(),
    );

    const exec = new DependencyGraphExecutor({ maxConcurrency: 5 });
    const result = await exec.execute(graph);

    // Every node should have completed.
    for (const id of AUTO_GEN_OPERATION_IDS) {
      expect(result.get(id), `op ${id} not complete`).toBe("complete");
    }

    // Spot-check a few dependency invariants.
    expect(order.indexOf("op-2-1a")).toBeLessThan(order.indexOf("op-2-1b"));
    expect(order.indexOf("op-2-1b")).toBeLessThan(order.indexOf("op-2-1c"));
    expect(order.indexOf("op-2-1c")).toBeLessThan(order.indexOf("op-2-2a"));
    expect(order.indexOf("op-2-1c")).toBeLessThan(order.indexOf("op-2-3a"));
    expect(order.indexOf("op-2-2a")).toBeLessThan(order.indexOf("op-2-2c"));
    expect(order.indexOf("op-2-2b")).toBeLessThan(order.indexOf("op-2-2c"));
    expect(order.indexOf("op-2-3b")).toBeLessThan(order.indexOf("op-2-3c"));
    expect(order.indexOf("op-2-3c")).toBeLessThan(order.indexOf("op-2-3d"));
    expect(order.indexOf("op-2-2c")).toBeLessThan(order.indexOf("op-2-4a"));
    expect(order.indexOf("op-2-3d")).toBeLessThan(order.indexOf("op-2-4a"));
    expect(order.indexOf("op-2-4a")).toBeLessThan(order.indexOf("op-2-4c"));
    expect(order.indexOf("op-2-4c")).toBeLessThan(order.indexOf("op-2-4d"));
    expect(order.indexOf("op-2-4d")).toBeLessThan(order.indexOf("op-2-5a"));
    expect(order.indexOf("op-2-5b")).toBeLessThan(order.indexOf("op-2-5c"));
    expect(order.indexOf("op-2-5c")).toBeLessThan(order.indexOf("op-2-5d"));
    expect(order.indexOf("op-2-5d")).toBeLessThan(order.indexOf("op-2-5e"));
  });

  it("skips op-2-3c when its condition returns false but still runs op-2-3d downstream", async () => {
    const order: string[] = [];
    const graph = buildAutoGenerationGraph(stubRunners(order), {
      "op-2-3c": async () => false,
      "op-2-5e": async () => true,
    });
    const result = await new DependencyGraphExecutor({
      maxConcurrency: 5,
    }).execute(graph);

    expect(result.get("op-2-3c")).toBe("skipped");
    expect(result.get("op-2-3d")).toBe("complete");
    expect(order).not.toContain("op-2-3c");
    expect(order).toContain("op-2-3d");
  });

  it("skips op-2-5e when its condition returns false", async () => {
    const order: string[] = [];
    const graph = buildAutoGenerationGraph(stubRunners(order), {
      "op-2-3c": async () => true,
      "op-2-5e": async () => false,
    });
    const result = await new DependencyGraphExecutor({
      maxConcurrency: 5,
    }).execute(graph);
    expect(result.get("op-2-5e")).toBe("skipped");
    expect(result.get("op-2-5d")).toBe("complete");
  });
});
