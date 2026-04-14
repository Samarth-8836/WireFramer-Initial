import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";
import type { PhaseState } from "@core/types";

import {
  transitionPhase,
  validateTransition,
} from "../phase-state-machine";

describe("validateTransition", () => {
  it("allows not_started -> active", () => {
    expect(validateTransition("not_started", "active")).toBe(true);
  });

  it("allows active -> completing and active -> suspended", () => {
    expect(validateTransition("active", "completing")).toBe(true);
    expect(validateTransition("active", "suspended")).toBe(true);
  });

  it("allows completing -> complete (PASS path) and completing -> active (FAIL path)", () => {
    expect(validateTransition("completing", "complete")).toBe(true);
    expect(validateTransition("completing", "active")).toBe(true);
  });

  it("allows suspended -> active (restore)", () => {
    expect(validateTransition("suspended", "active")).toBe(true);
  });

  it("rejects active -> complete (must go through completing)", () => {
    expect(validateTransition("active", "complete")).toBe(false);
  });

  it("rejects complete -> * (complete is terminal)", () => {
    expect(validateTransition("complete", "active")).toBe(false);
    expect(validateTransition("complete", "completing")).toBe(false);
    expect(validateTransition("complete", "suspended")).toBe(false);
    expect(validateTransition("complete", "not_started")).toBe(false);
  });

  it("rejects not_started -> completing / complete / suspended", () => {
    expect(validateTransition("not_started", "completing")).toBe(false);
    expect(validateTransition("not_started", "complete")).toBe(false);
    expect(validateTransition("not_started", "suspended")).toBe(false);
  });
});

describe("transitionPhase", () => {
  function seed(state: Partial<PhaseState>): MemoryStorage {
    const storage = new MemoryStorage();
    void storage.upsertPhaseState({
      sessionId: "s1",
      phaseId: "phase-1",
      status: "not_started",
      enteredAt: null,
      completedAt: null,
      suspendedAt: null,
      ...state,
    });
    return storage;
  }

  it("throws when no phase state exists", async () => {
    const storage = new MemoryStorage();
    await expect(
      transitionPhase(storage, "s1", "phase-1", "active"),
    ).rejects.toThrow(/no phase state/);
  });

  it("throws on invalid transition", async () => {
    const storage = seed({ status: "not_started" });
    await expect(
      transitionPhase(storage, "s1", "phase-1", "complete"),
    ).rejects.toThrow(/Invalid phase transition/);
  });

  it("sets enteredAt when moving not_started -> active", async () => {
    const storage = seed({ status: "not_started", enteredAt: null });
    const result = await transitionPhase(storage, "s1", "phase-1", "active");
    expect(result.status).toBe("active");
    expect(result.enteredAt).not.toBeNull();
  });

  it("sets completedAt when moving completing -> complete", async () => {
    const storage = seed({
      status: "completing",
      enteredAt: "2026-04-10T00:00:00.000Z",
    });
    const result = await transitionPhase(
      storage,
      "s1",
      "phase-1",
      "complete",
    );
    expect(result.status).toBe("complete");
    expect(result.completedAt).not.toBeNull();
  });

  it("sets suspendedAt when moving active -> suspended", async () => {
    const storage = seed({
      status: "active",
      enteredAt: "2026-04-10T00:00:00.000Z",
    });
    const result = await transitionPhase(
      storage,
      "s1",
      "phase-1",
      "suspended",
    );
    expect(result.status).toBe("suspended");
    expect(result.suspendedAt).not.toBeNull();
  });

  it("does NOT reset enteredAt on completing -> active (validation FAIL bounce)", async () => {
    const originalEntry = "2026-04-10T00:00:00.000Z";
    const storage = seed({
      status: "completing",
      enteredAt: originalEntry,
    });
    const result = await transitionPhase(storage, "s1", "phase-1", "active");
    expect(result.status).toBe("active");
    expect(result.enteredAt).toBe(originalEntry);
  });

  it("resets enteredAt on suspended -> active (restore)", async () => {
    const storage = seed({
      status: "suspended",
      enteredAt: "2026-04-10T00:00:00.000Z",
      suspendedAt: "2026-04-11T00:00:00.000Z",
    });
    const result = await transitionPhase(storage, "s1", "phase-1", "active");
    expect(result.status).toBe("active");
    expect(result.enteredAt).not.toBe("2026-04-10T00:00:00.000Z");
  });
});
