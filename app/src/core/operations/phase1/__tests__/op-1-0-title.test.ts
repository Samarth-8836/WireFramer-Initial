import { describe, expect, it } from "vitest";

import { PromptRegistry, registerPhase1Prompts } from "@core/prompts";

import { generateTitle } from "../op-1-0-title";

import { QueueExecutor } from "./test-helpers";

function registry(): PromptRegistry {
  const r = new PromptRegistry();
  registerPhase1Prompts(r);
  return r;
}

describe("generateTitle", () => {
  it("returns the cleaned title when the model emits 3-5 words", async () => {
    const exec = new QueueExecutor([{ rawText: "Task Tracker App" }]);
    const title = await generateTitle(exec, registry(), "i want a task tracker");
    expect(title).toBe("Task Tracker App");
    expect(exec.callCount).toBe(1);
  });

  it("strips surrounding quotes and trailing punctuation", async () => {
    const exec = new QueueExecutor([{ rawText: '  "Water Intake Tracker."  ' }]);
    const title = await generateTitle(exec, registry(), "track water");
    expect(title).toBe("Water Intake Tracker");
  });

  // Note: retry behavior on parse failure is tested at the Operation
  // Executor level in Sprint 2 (executor.unit.test.ts). op-1-0 relies on
  // that mechanism rather than reimplementing it, so we assert only what
  // the op itself controls: the parser contract and the fallback path.

  it("falls back to the first words of the user message when the model keeps failing", async () => {
    const exec = new QueueExecutor([
      { rawText: "A really very extremely long title of way too many words" },
    ]);
    const title = await generateTitle(
      exec,
      registry(),
      "Build a daily water intake tracking product",
    );
    // First 5 words of the user message — fallback path.
    expect(title).toBe("Build a daily water intake");
  });

  it("falls back to 'New Session' when the user message is also too short", async () => {
    const exec = new QueueExecutor([
      { rawText: "x y z a b c d e f g" }, // fails parser (10 words)
    ]);
    const title = await generateTitle(exec, registry(), "hi");
    expect(title).toBe("New Session");
  });

  it("falls back to the user message slice on executor failure", async () => {
    const exec = new QueueExecutor([
      { rawText: "unused", forceFailWith: "transport error" },
    ]);
    const title = await generateTitle(
      exec,
      registry(),
      "Build a task tracker app for teams",
    );
    // First 5 words of the user message.
    expect(title).toBe("Build a task tracker app");
  });
});
