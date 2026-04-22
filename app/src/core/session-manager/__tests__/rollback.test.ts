import { describe, expect, it } from "vitest";

import { SSEWriter } from "@core/operation-executor";
import { MemoryStorage } from "@core/storage";

import {
  createPhase1CompletionCheckpoint,
  executeRollback,
  handlePhase1ReCompletion,
  hasContractChanged,
  restorePhase2,
} from "../rollback";

// ---------- hasContractChanged ----------

describe("hasContractChanged", () => {
  const baseContract = `personas:
  - name: Buyer
  - name: Seller
entities:
  - name: Order
  - name: Product
boundaries:
  - No payments processing
  - No shipping management`;

  it("returns false when contracts are identical", () => {
    expect(hasContractChanged(baseContract, baseContract)).toBe(false);
  });

  it("returns false when only whitespace differs", () => {
    const withExtraWhitespace = baseContract.replace(/\n/g, "\n");
    expect(hasContractChanged(baseContract, withExtraWhitespace)).toBe(false);
  });

  it("returns true when a persona is added", () => {
    const withAdmin = `personas:
  - name: Buyer
  - name: Seller
  - name: Admin
entities:
  - name: Order
  - name: Product
boundaries:
  - No payments processing
  - No shipping management`;
    expect(hasContractChanged(baseContract, withAdmin)).toBe(true);
  });

  it("returns true when a persona is removed", () => {
    const withoutSeller = `personas:
  - name: Buyer
entities:
  - name: Order
  - name: Product
boundaries:
  - No payments processing
  - No shipping management`;
    expect(hasContractChanged(baseContract, withoutSeller)).toBe(true);
  });

  it("returns true when an entity is renamed", () => {
    const renamed = `personas:
  - name: Buyer
  - name: Seller
entities:
  - name: Purchase
  - name: Product
boundaries:
  - No payments processing
  - No shipping management`;
    expect(hasContractChanged(baseContract, renamed)).toBe(true);
  });

  it("returns true when a boundary statement changes", () => {
    const boundaryChanged = `personas:
  - name: Buyer
  - name: Seller
entities:
  - name: Order
  - name: Product
boundaries:
  - Yes payments processing
  - No shipping management`;
    expect(hasContractChanged(baseContract, boundaryChanged)).toBe(true);
  });

  it("treats persona order as irrelevant (set comparison)", () => {
    const reordered = `personas:
  - name: Seller
  - name: Buyer
entities:
  - name: Product
  - name: Order
boundaries:
  - No shipping management
  - No payments processing`;
    expect(hasContractChanged(baseContract, reordered)).toBe(false);
  });

  it("treats boundary case as irrelevant (normalized to lowercase)", () => {
    const mixedCase = `personas:
  - name: Buyer
  - name: Seller
entities:
  - name: Order
  - name: Product
boundaries:
  - NO PAYMENTS PROCESSING
  - No Shipping Management`;
    expect(hasContractChanged(baseContract, mixedCase)).toBe(false);
  });

  it("returns true on malformed YAML (conservative default)", () => {
    expect(hasContractChanged(baseContract, "::: broken yaml :::")).toBe(true);
  });
});

// ---------- executeRollback ----------

describe("executeRollback", () => {
  async function seed(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-2",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });
    await storage.upsertPhaseState({
      sessionId: "s1",
      phaseId: "phase-1",
      status: "complete",
      enteredAt: "2026-04-10T00:00:00.000Z",
      completedAt: "2026-04-10T00:30:00.000Z",
      suspendedAt: null,
    });
    await storage.upsertPhaseState({
      sessionId: "s1",
      phaseId: "phase-2",
      status: "active",
      enteredAt: "2026-04-10T00:30:00.000Z",
      completedAt: null,
      suspendedAt: null,
    });
    return storage;
  }

  function freshSSE(): SSEWriter {
    const w = new SSEWriter();
    w.createStream();
    return w;
  }

  it("suspends phase-2 and reactivates phase-1", async () => {
    const storage = await seed();
    await executeRollback(storage, "s1", freshSSE());

    const phase2 = await storage.getPhaseState("s1", "phase-2");
    expect(phase2?.status).toBe("suspended");
    expect(phase2?.suspendedAt).not.toBeNull();

    const phase1 = await storage.getPhaseState("s1", "phase-1");
    expect(phase1?.status).toBe("active");
    // On rollback re-entry, enteredAt is refreshed.
    expect(phase1?.enteredAt).not.toBe("2026-04-10T00:00:00.000Z");
    // completedAt is cleared on re-entry.
    expect(phase1?.completedAt).toBeNull();
  });

  it("updates session.currentPhaseId to phase-1", async () => {
    const storage = await seed();
    await executeRollback(storage, "s1", freshSSE());

    const session = await storage.getSession("s1");
    expect(session?.currentPhaseId).toBe("phase-1");
  });

  it("skips phase-2 suspension if it's not active", async () => {
    const storage = await seed();
    // Manually suspend phase-2 first.
    await storage.upsertPhaseState({
      sessionId: "s1",
      phaseId: "phase-2",
      status: "suspended",
      enteredAt: "2026-04-10T00:30:00.000Z",
      completedAt: null,
      suspendedAt: "2026-04-10T01:00:00.000Z",
    });

    // Should still complete rollback without error.
    await expect(
      executeRollback(storage, "s1", freshSSE()),
    ).resolves.not.toThrow();

    const phase1 = await storage.getPhaseState("s1", "phase-1");
    expect(phase1?.status).toBe("active");
  });
});

// ---------- handlePhase1ReCompletion ----------

describe("handlePhase1ReCompletion", () => {
  async function seedWithCheckpoint(
    originalContract: string,
  ): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });

    // Create the original active contract.
    const doc = await storage.createDocument({
      id: "doc-original",
      sessionId: "s1",
      phaseId: "phase-1",
      type: "project_contract",
      content: "# Contract\n\n...",
      structuredData: originalContract,
      version: 1,
      status: "active",
      createdAt: "2026-04-10T00:00:00.000Z",
      lastModifiedAt: "2026-04-10T00:00:00.000Z",
    });

    // Create checkpoint #2 representing the original completion.
    await storage.createCheckpoint({
      id: "ckpt-2",
      sessionId: "s1",
      phaseId: "phase-1",
      number: 2,
      createdAt: "2026-04-10T00:30:00.000Z",
      documentSnapshots: [
        {
          documentId: doc.id,
          content: doc.content,
          structuredData: originalContract,
          version: 1,
        },
      ],
      artifactSnapshots: [],
    });

    return storage;
  }

  const originalContract = `personas:
  - name: Buyer
entities:
  - name: Order
boundaries:
  - No refunds`;

  it('returns "restore" when contract is unchanged', async () => {
    const storage = await seedWithCheckpoint(originalContract);
    const decision = await handlePhase1ReCompletion(storage, "s1");
    expect(decision).toBe("restore");
  });

  it('returns "regenerate" when a persona was added', async () => {
    const storage = await seedWithCheckpoint(originalContract);
    // Replace the active contract with a modified one.
    await storage.deactivateDocuments("s1", "project_contract");
    await storage.createDocument({
      id: "doc-modified",
      sessionId: "s1",
      phaseId: "phase-1",
      type: "project_contract",
      content: "# Contract v2\n\n...",
      structuredData: `personas:
  - name: Buyer
  - name: Seller
entities:
  - name: Order
boundaries:
  - No refunds`,
      version: 2,
      status: "active",
      createdAt: "2026-04-10T01:00:00.000Z",
      lastModifiedAt: "2026-04-10T01:00:00.000Z",
    });

    const decision = await handlePhase1ReCompletion(storage, "s1");
    expect(decision).toBe("regenerate");
  });

  it('returns "regenerate" when no checkpoint exists', async () => {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });

    const decision = await handlePhase1ReCompletion(storage, "s1");
    expect(decision).toBe("regenerate");
  });
});

// ---------- restorePhase2 ----------

describe("restorePhase2", () => {
  it("reactivates a suspended phase-2 and updates currentPhaseId", async () => {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });
    await storage.upsertPhaseState({
      sessionId: "s1",
      phaseId: "phase-2",
      status: "suspended",
      enteredAt: "2026-04-10T00:30:00.000Z",
      completedAt: null,
      suspendedAt: "2026-04-10T01:00:00.000Z",
    });

    const sse = new SSEWriter();
    sse.createStream();
    await restorePhase2(storage, "s1", sse);

    const phase2 = await storage.getPhaseState("s1", "phase-2");
    expect(phase2?.status).toBe("active");

    const session = await storage.getSession("s1");
    expect(session?.currentPhaseId).toBe("phase-2");
  });

  it("does not transition when phase-2 is not in suspended state", async () => {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });
    // phase-2 doesn't exist yet.

    const sse = new SSEWriter();
    sse.createStream();
    await restorePhase2(storage, "s1", sse);

    // Session currentPhaseId still updated.
    const session = await storage.getSession("s1");
    expect(session?.currentPhaseId).toBe("phase-2");
  });
});

// ---------- createPhase1CompletionCheckpoint ----------

describe("createPhase1CompletionCheckpoint", () => {
  it("creates checkpoint #2 with the active contract snapshot", async () => {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });

    const doc = await storage.createDocument({
      id: "doc-1",
      sessionId: "s1",
      phaseId: "phase-1",
      type: "project_contract",
      content: "# Contract",
      structuredData: "personas: []",
      version: 1,
      status: "active",
      createdAt: "2026-04-10T00:00:00.000Z",
      lastModifiedAt: "2026-04-10T00:00:00.000Z",
    });

    const checkpoint = await createPhase1CompletionCheckpoint(storage, "s1");

    expect(checkpoint.number).toBe(2);
    expect(checkpoint.phaseId).toBe("phase-1");
    expect(checkpoint.documentSnapshots).toHaveLength(1);
    expect(checkpoint.documentSnapshots[0].documentId).toBe(doc.id);
    expect(checkpoint.documentSnapshots[0].content).toBe("# Contract");
  });

  it("creates checkpoint with empty snapshots when no active contract exists", async () => {
    const storage = new MemoryStorage();
    await storage.createSession({
      id: "s1",
      title: "Test",
      currentPhaseId: "phase-1",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "active",
    });

    const checkpoint = await createPhase1CompletionCheckpoint(storage, "s1");
    expect(checkpoint.documentSnapshots).toEqual([]);
    expect(checkpoint.artifactSnapshots).toEqual([]);
  });
});
