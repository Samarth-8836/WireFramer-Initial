import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";
import type { Phase2Stage } from "@core/types";

import {
  canAdvanceStage,
  getPhase2Stage,
  isPhase2StageRunning,
  isPhase2StageReview,
  setPhase2Stage,
  stageAfterRunning,
} from "../index";

describe("canAdvanceStage", () => {
  it("allows design_review → wireframe_running", () => {
    const r = canAdvanceStage("design_review");
    expect(r.ok).toBe(true);
    expect(r.next).toBe("wireframe_running");
    expect(r.reason).toBeNull();
  });

  it("allows wireframe_review → test_suite_running", () => {
    const r = canAdvanceStage("wireframe_review");
    expect(r.ok).toBe(true);
    expect(r.next).toBe("test_suite_running");
  });

  it("allows test_suite_review → automated_tests_running", () => {
    const r = canAdvanceStage("test_suite_review");
    expect(r.ok).toBe(true);
    expect(r.next).toBe("automated_tests_running");
  });

  it("rejects advance from a *_running stage (user can't approve mid-run)", () => {
    expect(canAdvanceStage("design_running").ok).toBe(false);
    expect(canAdvanceStage("wireframe_running").ok).toBe(false);
    expect(canAdvanceStage("test_suite_running").ok).toBe(false);
    expect(canAdvanceStage("automated_tests_running").ok).toBe(false);
  });

  it("rejects advance from not_started", () => {
    const r = canAdvanceStage("not_started");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not_started");
  });

  it("rejects advance from complete", () => {
    expect(canAdvanceStage("complete").ok).toBe(false);
  });

  it("treats null/undefined as not_started", () => {
    expect(canAdvanceStage(null).ok).toBe(false);
    expect(canAdvanceStage(undefined).ok).toBe(false);
  });
});

describe("stageAfterRunning", () => {
  it("design_running → design_review", () => {
    expect(stageAfterRunning("design_running")).toBe("design_review");
  });

  it("wireframe_running → wireframe_review", () => {
    expect(stageAfterRunning("wireframe_running")).toBe("wireframe_review");
  });

  it("test_suite_running → test_suite_review", () => {
    expect(stageAfterRunning("test_suite_running")).toBe("test_suite_review");
  });

  it("automated_tests_running → complete (skips review)", () => {
    expect(stageAfterRunning("automated_tests_running")).toBe("complete");
  });

  it("throws for non-running input", () => {
    expect(() => stageAfterRunning("design_review")).toThrow();
    expect(() => stageAfterRunning("not_started")).toThrow();
    expect(() => stageAfterRunning("complete")).toThrow();
  });
});

describe("isPhase2StageRunning / isPhase2StageReview", () => {
  it("running states", () => {
    const running: Phase2Stage[] = [
      "design_running",
      "wireframe_running",
      "test_suite_running",
      "automated_tests_running",
    ];
    for (const s of running) {
      expect(isPhase2StageRunning(s)).toBe(true);
      expect(isPhase2StageReview(s)).toBe(false);
    }
  });

  it("review states", () => {
    const review: Phase2Stage[] = [
      "design_review",
      "wireframe_review",
      "test_suite_review",
    ];
    for (const s of review) {
      expect(isPhase2StageReview(s)).toBe(true);
      expect(isPhase2StageRunning(s)).toBe(false);
    }
  });

  it("terminal / initial states are neither", () => {
    expect(isPhase2StageRunning("not_started")).toBe(false);
    expect(isPhase2StageReview("not_started")).toBe(false);
    expect(isPhase2StageRunning("complete")).toBe(false);
    expect(isPhase2StageReview("complete")).toBe(false);
  });

  it("null/undefined default to not_started behavior", () => {
    expect(isPhase2StageRunning(null)).toBe(false);
    expect(isPhase2StageReview(undefined)).toBe(false);
  });
});

describe("setPhase2Stage / getPhase2Stage", () => {
  async function seed(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
      status: "active",
    });
    return storage;
  }

  it("persists the stage on the session record", async () => {
    const storage = await seed();
    const updated = await setPhase2Stage(storage, "s1", "design_running");
    expect(updated.phase2Stage).toBe("design_running");

    const stored = await storage.getSession("s1");
    expect(stored?.phase2Stage).toBe("design_running");
  });

  it("reads back the persisted stage", async () => {
    const storage = await seed();
    await setPhase2Stage(storage, "s1", "wireframe_review");
    expect(await getPhase2Stage(storage, "s1")).toBe("wireframe_review");
  });

  it('defaults to "not_started" when no stage is persisted', async () => {
    const storage = await seed();
    expect(await getPhase2Stage(storage, "s1")).toBe("not_started");
  });

  it('returns "not_started" for a missing session (no throw)', async () => {
    const storage = new MemoryStorage();
    expect(await getPhase2Stage(storage, "does-not-exist")).toBe(
      "not_started",
    );
  });
});
