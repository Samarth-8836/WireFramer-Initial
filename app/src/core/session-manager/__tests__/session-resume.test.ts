import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";
import { resumeInterruptedSessions } from "../session-resume";

describe("resumeInterruptedSessions", () => {
  it("returns empty report when no sessions exist", async () => {
    const storage = new MemoryStorage();
    const report = await resumeInterruptedSessions(storage);

    expect(report.sessionsScanned).toBe(0);
    expect(report.interruptedOperations).toHaveLength(0);
  });

  it("marks in_progress operations as failed", async () => {
    const storage = new MemoryStorage();

    // Create a session with an in-progress operation.
    await storage.createSession({
      id: "s1",
      title: "Test Session",
      currentPhaseId: "phase-2",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      status: "active",
    });

    await storage.upsertOperationProgress({
      sessionId: "s1",
      operationId: "op-2-1a",
      status: "in_progress",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      batchItems: null,
    });

    const report = await resumeInterruptedSessions(storage);

    expect(report.sessionsScanned).toBe(1);
    expect(report.interruptedOperations).toHaveLength(1);
    expect(report.interruptedOperations[0]).toMatchObject({
      sessionId: "s1",
      operationId: "op-2-1a",
    });

    // Verify the operation is now marked as failed.
    const op = await storage.getOperationProgress("s1", "op-2-1a");
    expect(op?.status).toBe("failed");
    expect(op?.error).toContain("interrupted by server restart");
  });

  it("does not touch completed operations", async () => {
    const storage = new MemoryStorage();

    await storage.createSession({
      id: "s1",
      title: "Done Session",
      currentPhaseId: "phase-2",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      status: "active",
    });

    await storage.upsertOperationProgress({
      sessionId: "s1",
      operationId: "op-2-1a",
      status: "complete",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: "2026-04-01T00:01:00.000Z",
      error: null,
      batchItems: null,
    });

    const report = await resumeInterruptedSessions(storage);

    expect(report.interruptedOperations).toHaveLength(0);

    const op = await storage.getOperationProgress("s1", "op-2-1a");
    expect(op?.status).toBe("complete");
  });

  it("handles multiple sessions with mixed operation states", async () => {
    const storage = new MemoryStorage();

    // Session 1: has one in_progress op.
    await storage.createSession({
      id: "s1",
      title: "Session 1",
      currentPhaseId: "phase-2",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      status: "active",
    });
    await storage.upsertOperationProgress({
      sessionId: "s1",
      operationId: "op-2-1a",
      status: "in_progress",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      batchItems: null,
    });

    // Session 2: all ops complete.
    await storage.createSession({
      id: "s2",
      title: "Session 2",
      currentPhaseId: "phase-2",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      status: "active",
    });
    await storage.upsertOperationProgress({
      sessionId: "s2",
      operationId: "op-2-1a",
      status: "complete",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: "2026-04-01T00:01:00.000Z",
      error: null,
      batchItems: null,
    });

    const report = await resumeInterruptedSessions(storage);

    expect(report.sessionsScanned).toBe(2);
    expect(report.interruptedOperations).toHaveLength(1);
    expect(report.interruptedOperations[0].sessionId).toBe("s1");
  });
});
