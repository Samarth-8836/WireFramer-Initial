import type { GraphNode } from "./dependency-graph";

// The full Phase 2 auto-generation topology from spec §4.4 / §18.1.
//
// This file owns the *topology* — which ops depend on which, and which
// ones are conditional. The actual op implementations don't land until
// Sprints 6-8, so the builder takes a dictionary of op runners and a
// dictionary of condition predicates. Tests and future sprints plug in
// whatever they need:
//   - Sprint 4 (now): unit tests pass in mock runners and verify topology.
//   - Sprint 6 onward: real session manager wires real operation runners.

// Every auto-gen op id, keyed for strong-typing the factory dictionary.
// Keep this list in sync with the dependency graph below.
export const AUTO_GEN_OPERATION_IDS = [
  "op-2-1a",
  "op-2-1b",
  "op-2-1c",
  "op-2-2a",
  "op-2-2b",
  "op-2-2c",
  "op-2-3a",
  "op-2-3b",
  "op-2-3c",
  "op-2-3d",
  "op-2-4a",
  "op-2-4b",
  "op-2-4c",
  "op-2-4d",
  "op-2-4e",
  "op-2-5a",
  "op-2-5b",
  "op-2-5c",
  "op-2-5d",
  "op-2-5e",
] as const;

export type AutoGenOperationId = (typeof AUTO_GEN_OPERATION_IDS)[number];

export type AutoGenRunner = () => Promise<void>;
export type AutoGenCondition = () => Promise<boolean>;

// Runners for every op in the graph. Required — there is no default, so
// tests and the session manager are forced to be explicit about what gets
// executed at each node.
export type AutoGenRunners = Record<AutoGenOperationId, AutoGenRunner>;

// Only the conditional nodes need predicates. op-2-3c runs when op-2-3b
// (screen validation) flags issues; op-2-5e runs when op-2-5d (test
// translation) surfaces failures. Everything else is unconditional.
export interface AutoGenConditions {
  "op-2-3c": AutoGenCondition;
  "op-2-5e": AutoGenCondition;
}

export function buildAutoGenerationGraph(
  runners: AutoGenRunners,
  conditions: AutoGenConditions,
): GraphNode[] {
  return [
    // Workflow discovery + detail + assembly.
    { operationId: "op-2-1a", dependencies: [], execute: runners["op-2-1a"] },
    { operationId: "op-2-1b", dependencies: ["op-2-1a"], execute: runners["op-2-1b"] },
    { operationId: "op-2-1c", dependencies: ["op-2-1b"], execute: runners["op-2-1c"] },

    // Test case generation branch (parallel with screen branch off 2-1c).
    { operationId: "op-2-2a", dependencies: ["op-2-1c"], execute: runners["op-2-2a"] },
    { operationId: "op-2-2b", dependencies: ["op-2-1c"], execute: runners["op-2-2b"] },
    {
      operationId: "op-2-2c",
      dependencies: ["op-2-2a", "op-2-2b"],
      execute: runners["op-2-2c"],
    },

    // Screen extraction + validation branch.
    { operationId: "op-2-3a", dependencies: ["op-2-1c"], execute: runners["op-2-3a"] },
    { operationId: "op-2-3b", dependencies: ["op-2-3a"], execute: runners["op-2-3b"] },
    {
      operationId: "op-2-3c",
      dependencies: ["op-2-3b"],
      condition: conditions["op-2-3c"],
      execute: runners["op-2-3c"],
    },
    // op-2-3d waits for 2-3c so the inventory includes any fixes made
    // during the conditional remediation pass. When 2-3c is skipped, the
    // DAG executor treats the skip as dependency-satisfied and 2-3d
    // proceeds immediately.
    {
      operationId: "op-2-3d",
      dependencies: ["op-2-3c"],
      execute: runners["op-2-3d"],
    },

    // HTML generation branch — needs both test suite (2-2c) and finalized
    // screen inventory (2-3d) before the first-pass HTML can render.
    {
      operationId: "op-2-4a",
      dependencies: ["op-2-2c", "op-2-3d"],
      execute: runners["op-2-4a"],
    },
    { operationId: "op-2-4b", dependencies: ["op-2-3d"], execute: runners["op-2-4b"] },
    { operationId: "op-2-4c", dependencies: ["op-2-4a"], execute: runners["op-2-4c"] },
    { operationId: "op-2-4d", dependencies: ["op-2-4c"], execute: runners["op-2-4d"] },
    { operationId: "op-2-4e", dependencies: ["op-2-4a"], execute: runners["op-2-4e"] },

    // Test translation + execution + remediation branch.
    { operationId: "op-2-5a", dependencies: ["op-2-4d"], execute: runners["op-2-5a"] },
    {
      operationId: "op-2-5b",
      dependencies: ["op-2-4d", "op-2-2c"],
      execute: runners["op-2-5b"],
    },
    { operationId: "op-2-5c", dependencies: ["op-2-5b"], execute: runners["op-2-5c"] },
    { operationId: "op-2-5d", dependencies: ["op-2-5c"], execute: runners["op-2-5d"] },
    {
      operationId: "op-2-5e",
      dependencies: ["op-2-5d"],
      condition: conditions["op-2-5e"],
      execute: runners["op-2-5e"],
    },
  ];
}
