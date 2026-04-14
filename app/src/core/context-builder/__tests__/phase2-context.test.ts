import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@core/storage";
import type { ConversationSummary } from "@core/storage";
import type { Document } from "@core/types";

import {
  buildPhase2SystemContext,
  buildScreenSummary,
  buildWorkflowSummary,
  getFullScreenDetail,
  getWorkflowsForScreen,
} from "../phase2-context";
import {
  seedContract,
  seedScreenInventory,
  seedWorkflowMap,
} from "./test-helpers";

function makeDoc(structuredData: string, type: "workflow_map" | "screen_inventory"): Document {
  return {
    id: "doc-x",
    sessionId: "s1",
    phaseId: "phase-2",
    type,
    content: "",
    structuredData,
    version: 1,
    status: "active",
    createdAt: "2026-04-14T00:00:00Z",
    lastModifiedAt: "2026-04-14T00:00:00Z",
  };
}

function makeSummary(text: string): ConversationSummary {
  return {
    sessionId: "s1",
    phaseId: "phase-2",
    summary: text,
    lastUpdatedAt: "2026-04-14T00:00:00Z",
    messagesCovered: 1,
  };
}

const WORKFLOW_YAML = `
workflows:
  - id: wf-001
    name: User signup
    persona: new_user
    category: onboarding
    steps:
      - screen: screen-001
        action: Fill the form
      - screen: screen-002
        action: Confirm email
    edgeCases:
      - Duplicate email
      - Weak password
  - id: wf-002
    name: User login
    persona: returning_user
    category: authentication
    steps:
      - screen: screen-003
        action: Enter credentials
    edgeCases: []
`;

const SCREEN_YAML = `
screens:
  - id: screen-001
    name: Signup form
    type: form
    description: Initial signup entry
    personas:
      - new_user
    workflows:
      - wf-001
    actions:
      - Submit
      - Cancel
    dataDisplayed:
      - Field labels
  - id: screen-002
    name: Email confirmation
    type: confirmation
    actions:
      - Resend email
  - id: screen-003
    name: Login
    type: form
    actions:
      - Submit
      - Forgot password
`;

describe("buildWorkflowSummary", () => {
  it("returns '(no workflows)' when structuredData is empty", () => {
    const doc = makeDoc("", "workflow_map");
    expect(buildWorkflowSummary(doc, null)).toBe("(no workflows)");
  });

  it("returns '(no workflows)' when YAML parses but has no workflows key", () => {
    const doc = makeDoc("workflows: []", "workflow_map");
    expect(buildWorkflowSummary(doc, null)).toBe("(no workflows)");
  });

  it("lists each workflow with persona, category, step count, edge case count", () => {
    const doc = makeDoc(WORKFLOW_YAML, "workflow_map");
    const out = buildWorkflowSummary(doc, null);
    expect(out).toContain("- wf-001: User signup [persona: new_user, category: onboarding, steps: 2, edge cases: 2]");
    expect(out).toContain("- wf-002: User login [persona: returning_user, category: authentication, steps: 1, edge cases: 0]");
  });

  it("annotates recently modified workflows when their id appears in the conversation summary", () => {
    const doc = makeDoc(WORKFLOW_YAML, "workflow_map");
    const summary = makeSummary(
      "Iteration 1: Renamed signup flow [scope: workflow-level, affected: wf-001]",
    );
    const out = buildWorkflowSummary(doc, summary);
    expect(out).toContain("wf-001: User signup");
    expect(out).toContain("(recently modified)");
    // wf-002 is not mentioned in the summary, so no annotation.
    const wf002Line = out.split("\n").find((l) => l.includes("wf-002"));
    expect(wf002Line).toBeDefined();
    expect(wf002Line).not.toContain("(recently modified)");
  });

  it("gracefully handles malformed YAML by returning '(no workflows)'", () => {
    const doc = makeDoc(":::not yaml:::\n  - [x", "workflow_map");
    expect(buildWorkflowSummary(doc, null)).toBe("(no workflows)");
  });
});

describe("buildScreenSummary", () => {
  it("lists each screen with type and action count", () => {
    const doc = makeDoc(SCREEN_YAML, "screen_inventory");
    const out = buildScreenSummary(doc, null);
    expect(out).toContain("- screen-001: Signup form [type: form, actions: 2]");
    expect(out).toContain("- screen-002: Email confirmation [type: confirmation, actions: 1]");
    expect(out).toContain("- screen-003: Login [type: form, actions: 2]");
  });

  it("annotates recently modified screens", () => {
    const doc = makeDoc(SCREEN_YAML, "screen_inventory");
    const summary = makeSummary(
      "Iteration 3: Redesigned login [scope: screen-level, affected: screen-003]",
    );
    const out = buildScreenSummary(doc, summary);
    const line = out.split("\n").find((l) => l.includes("screen-003"));
    expect(line).toBeDefined();
    expect(line).toContain("(recently modified)");
  });

  it("returns '(no screens)' for empty structuredData", () => {
    expect(buildScreenSummary(makeDoc("", "screen_inventory"), null)).toBe(
      "(no screens)",
    );
  });
});

describe("getFullScreenDetail", () => {
  it("returns full detail for a matching screen id", () => {
    const doc = makeDoc(SCREEN_YAML, "screen_inventory");
    const out = getFullScreenDetail(doc, "screen-001");
    expect(out).not.toBeNull();
    expect(out).toContain("ID: screen-001");
    expect(out).toContain("Name: Signup form");
    expect(out).toContain("Type: form");
    expect(out).toContain("Description: Initial signup entry");
    expect(out).toContain("Personas: new_user");
    expect(out).toContain("Workflows: wf-001");
    expect(out).toContain("Actions:");
    expect(out).toContain("  - Submit");
    expect(out).toContain("  - Cancel");
    expect(out).toContain("Data displayed:");
  });

  it("returns null when the screen id is not present", () => {
    const doc = makeDoc(SCREEN_YAML, "screen_inventory");
    expect(getFullScreenDetail(doc, "screen-999")).toBeNull();
  });

  it("returns null when structuredData is empty", () => {
    expect(getFullScreenDetail(makeDoc("", "screen_inventory"), "screen-001")).toBeNull();
  });
});

describe("getWorkflowsForScreen", () => {
  it("returns workflows whose steps reference the given screen id", () => {
    const doc = makeDoc(WORKFLOW_YAML, "workflow_map");
    const out = getWorkflowsForScreen(doc, "screen-001");
    expect(out).not.toBeNull();
    expect(out).toContain("- wf-001: User signup (persona: new_user)");
    expect(out).not.toContain("wf-002");
  });

  it("returns null when no workflow references the screen", () => {
    const doc = makeDoc(WORKFLOW_YAML, "workflow_map");
    expect(getWorkflowsForScreen(doc, "screen-404")).toBeNull();
  });
});

describe("buildPhase2SystemContext", () => {
  it("throws when no active project contract exists", async () => {
    const storage = new MemoryStorage();
    await expect(
      buildPhase2SystemContext(storage, "s-missing", null),
    ).rejects.toThrow(/active project contract/);
  });

  it("returns contract only when no workflow map / screen inventory / summary present", async () => {
    const storage = new MemoryStorage();
    await seedContract(storage, "s1", "THE CONTRACT CONTENT");

    const out = await buildPhase2SystemContext(storage, "s1", null);

    expect(out).toContain("## Project Contract");
    expect(out).toContain("THE CONTRACT CONTENT");
    expect(out).not.toContain("## Changes Made So Far");
    expect(out).not.toContain("## Current Workflow Map");
    expect(out).not.toContain("## Current Screen Inventory");
    expect(out).not.toContain("## Currently Viewed Screen");
  });

  it("includes conversation summary + workflow + screen sections when all present", async () => {
    const storage = new MemoryStorage();
    await seedContract(storage, "s1", "CONTRACT");
    await seedWorkflowMap(storage, "s1", WORKFLOW_YAML);
    await seedScreenInventory(storage, "s1", SCREEN_YAML);
    await storage.upsertConversationSummary({
      sessionId: "s1",
      phaseId: "phase-2",
      summary: "Iteration 1: Tightened signup flow [affected: wf-001]",
      lastUpdatedAt: "2026-04-14T00:00:00Z",
      messagesCovered: 1,
    });

    const out = await buildPhase2SystemContext(storage, "s1", null);

    expect(out).toContain("## Project Contract");
    expect(out).toContain("## Changes Made So Far in Phase 2");
    expect(out).toContain("Iteration 1: Tightened signup flow");
    expect(out).toContain("## Current Workflow Map");
    expect(out).toContain("wf-001: User signup");
    expect(out).toContain("(recently modified)"); // from the summary
    expect(out).toContain("## Current Screen Inventory");
    expect(out).toContain("screen-001: Signup form");
  });

  it("adds the 'Currently Viewed Screen' + 'Workflows Touching This Screen' sections when screenRef is provided", async () => {
    const storage = new MemoryStorage();
    await seedContract(storage, "s1", "CONTRACT");
    await seedWorkflowMap(storage, "s1", WORKFLOW_YAML);
    await seedScreenInventory(storage, "s1", SCREEN_YAML);

    const out = await buildPhase2SystemContext(storage, "s1", "screen-001");

    expect(out).toContain("## Currently Viewed Screen (Full Detail)");
    expect(out).toContain("ID: screen-001");
    expect(out).toContain("Name: Signup form");
    expect(out).toContain("## Workflows Touching This Screen");
    expect(out).toContain("wf-001: User signup");
  });

  it("omits screen detail sections when screenRef does not match any screen", async () => {
    const storage = new MemoryStorage();
    await seedContract(storage, "s1", "CONTRACT");
    await seedWorkflowMap(storage, "s1", WORKFLOW_YAML);
    await seedScreenInventory(storage, "s1", SCREEN_YAML);

    const out = await buildPhase2SystemContext(storage, "s1", "screen-404");

    expect(out).not.toContain("## Currently Viewed Screen");
    expect(out).not.toContain("## Workflows Touching This Screen");
  });
});
