import { describe, expect, it } from "vitest";

import { routeMessage } from "../operation-router";

describe("routeMessage", () => {
  it("routes Phase 1 with no existing documents to op-1-1 (goal expansion)", () => {
    expect(
      routeMessage({ phaseId: "phase-1", hasExistingDocuments: false }),
    ).toBe("op-1-1");
  });

  it("routes Phase 1 with existing documents to op-1-2 (iteration)", () => {
    expect(
      routeMessage({ phaseId: "phase-1", hasExistingDocuments: true }),
    ).toBe("op-1-2");
  });

  it("routes Phase 2 to op-2-7a regardless of documents flag", () => {
    expect(
      routeMessage({ phaseId: "phase-2", hasExistingDocuments: false }),
    ).toBe("op-2-7a");
    expect(
      routeMessage({ phaseId: "phase-2", hasExistingDocuments: true }),
    ).toBe("op-2-7a");
  });
});
