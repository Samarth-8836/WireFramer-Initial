// Rollback system — Sprint 9.
//
// Implements Phase 2 → Phase 1 rollback, contract comparison, and
// conditional Phase 2 restore vs. regeneration.

import { parse as parseYamlLib } from "yaml";
import { v4 as uuidv4 } from "uuid";

import type { SSEWriter } from "@core/operation-executor";
import type { IStorage } from "@core/storage";
import type { Checkpoint, DocumentSnapshot } from "@core/types";

import { transitionPhase } from "./phase-state-machine";

// ── Contract comparison (programmatic, NOT AI) ────────────────

export function hasContractChanged(
  oldStructuredData: string,
  newStructuredData: string,
): boolean {
  const oldData = safeParse(oldStructuredData);
  const newData = safeParse(newStructuredData);
  if (!oldData || !newData) return true; // Can't compare — assume changed.

  // Compare persona names as sets.
  const oldPersonas = extractNames(oldData, "personas");
  const newPersonas = extractNames(newData, "personas");
  if (!setsEqual(oldPersonas, newPersonas)) return true;

  // Compare entity names as sets.
  const oldEntities = extractNames(oldData, "entities");
  const newEntities = extractNames(newData, "entities");
  if (!setsEqual(oldEntities, newEntities)) return true;

  // Compare boundary statements as sets.
  const oldBoundaries = new Set(
    ((oldData.boundaries as string[]) ?? []).map((b) => b.trim().toLowerCase()),
  );
  const newBoundaries = new Set(
    ((newData.boundaries as string[]) ?? []).map((b) => b.trim().toLowerCase()),
  );
  if (!setsEqual(oldBoundaries, newBoundaries)) return true;

  return false; // Cosmetic changes only.
}

// ── Rollback: Phase 2 → Phase 1 ──────────────────────────────

export async function executeRollback(
  storage: IStorage,
  sessionId: string,
  sse: SSEWriter,
): Promise<void> {
  // 1. Suspend Phase 2.
  const phase2State = await storage.getPhaseState(sessionId, "phase-2");
  if (phase2State && phase2State.status === "active") {
    await transitionPhase(storage, sessionId, "phase-2", "suspended");
    sse.sendProgress({
      operationId: "rollback",
      status: "in_progress",
      detail: "Phase 2 suspended",
    });
  }

  // 2. Reactivate Phase 1.
  await transitionPhase(storage, sessionId, "phase-1", "active");
  await storage.updateSession(sessionId, { currentPhaseId: "phase-1" });

  sse.send({
    type: "phase",
    data: { phaseId: "phase-1", status: "active" },
  });

  sse.sendProgress({
    operationId: "rollback",
    status: "complete",
    detail: "Rolled back to Phase 1",
  });

  sse.sendComplete({ event: "rollback_complete" });
}

// ── Phase 1 re-completion: restore or regenerate Phase 2 ─────

export async function handlePhase1ReCompletion(
  storage: IStorage,
  sessionId: string,
): Promise<"restore" | "regenerate"> {
  // Find the checkpoint created at Phase 1's original completion.
  const checkpoint = await storage.getCheckpointByNumber(sessionId, 2);
  if (!checkpoint) {
    // No checkpoint — must regenerate.
    return "regenerate";
  }

  // Get the contract from the checkpoint.
  const oldContractSnapshot = checkpoint.documentSnapshots.find(
    (s) => s.documentId.includes("project_contract") || true,
  );
  const oldStructuredData = oldContractSnapshot?.structuredData ?? "";

  // Get the current active contract.
  const docs = await storage.getDocumentsBySession(sessionId);
  const currentContract = docs.find(
    (d) => d.type === "project_contract" && d.status === "active",
  );
  const newStructuredData = currentContract?.structuredData ?? "";

  if (hasContractChanged(oldStructuredData, newStructuredData)) {
    return "regenerate";
  }

  return "restore";
}

// ── Restore suspended Phase 2 ────────────────────────────────

export async function restorePhase2(
  storage: IStorage,
  sessionId: string,
  sse: SSEWriter,
): Promise<void> {
  // Reactivate Phase 2.
  const phase2State = await storage.getPhaseState(sessionId, "phase-2");
  if (phase2State && phase2State.status === "suspended") {
    await transitionPhase(storage, sessionId, "phase-2", "active");
  }
  await storage.updateSession(sessionId, { currentPhaseId: "phase-2" });

  sse.send({
    type: "phase",
    data: { phaseId: "phase-2", status: "active", detail: "restored" },
  });
}

// ── Create Phase 1 completion checkpoint ─────────────────────

export async function createPhase1CompletionCheckpoint(
  storage: IStorage,
  sessionId: string,
): Promise<Checkpoint> {
  const docs = await storage.getDocumentsBySession(sessionId);
  const activeContract = docs.find(
    (d) => d.type === "project_contract" && d.status === "active",
  );

  const documentSnapshots: DocumentSnapshot[] = activeContract
    ? [
        {
          documentId: activeContract.id,
          content: activeContract.content,
          structuredData: activeContract.structuredData,
          version: activeContract.version,
        },
      ]
    : [];

  const checkpoint: Checkpoint = {
    id: uuidv4(),
    sessionId,
    phaseId: "phase-1",
    number: 2,
    createdAt: new Date().toISOString(),
    documentSnapshots,
    artifactSnapshots: [],
  };

  return storage.createCheckpoint(checkpoint);
}

// ── Helpers ───────────────────────────────────────────────────

function safeParse(yaml: string): Record<string, unknown> | null {
  try {
    return parseYamlLib(yaml) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractNames(
  data: Record<string, unknown>,
  key: string,
): Set<string> {
  const arr = (data[key] ?? []) as Record<string, unknown>[];
  return new Set(
    arr.map((item) =>
      ((item.name as string) ?? "").trim().toLowerCase(),
    ),
  );
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
