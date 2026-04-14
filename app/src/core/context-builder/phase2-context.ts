import yaml from "yaml";

import type { Document } from "@core/types";
import type { ConversationSummary, IStorage } from "@core/storage/interface";

// Phase 2 system context — the most complex context assembly in the system
// (spec §6.2). When the user is in Phase 2 and wants to chat about their
// generated wireframes, this function produces the system-level "state of
// the world" block that the LLM sees alongside the conversational prompt:
//
//   - full project contract
//   - running conversation summary (iteration log)
//   - workflow map summary (all workflows, recent ones annotated)
//   - screen inventory summary (all screens, recent ones annotated)
//   - if a specific screen is currently being viewed: its full detail +
//     any workflows that touch it
//
// The point is to give the LLM enough context to reason about a change
// *without* having to re-fetch the whole document each turn.

// Shape assumptions for structuredData. These define the contract between
// the Phase 2 ops that GENERATE workflow maps / screen inventories
// (Sprint 6-7) and the Context Builder that READS them. If downstream ops
// emit a different shape, both sides need to stay in lockstep.
interface WorkflowMapYaml {
  workflows?: WorkflowYaml[];
}
interface WorkflowYaml {
  id?: string;
  name?: string;
  persona?: string;
  category?: string;
  steps?: { screen?: string; action?: string }[];
  edgeCases?: string[];
}
interface ScreenInventoryYaml {
  screens?: ScreenYaml[];
}
interface ScreenYaml {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  personas?: string[];
  workflows?: string[];
  actions?: string[];
  dataDisplayed?: string[];
}

function safeParse<T>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;
  try {
    return yaml.parse(raw) as T;
  } catch {
    // Structured data that can't round-trip through YAML is a data-quality
    // problem upstream. We return null here rather than throwing so the
    // Phase 2 context still renders the contract + chat history; the LLM
    // will see a "(no workflows)" section instead of a 500.
    return null;
  }
}

export async function buildPhase2SystemContext(
  storage: IStorage,
  sessionId: string,
  screenRef: string | null,
): Promise<string> {
  const contract = await storage.getActiveDocument(
    sessionId,
    "project_contract",
  );
  if (!contract) {
    throw new Error(
      `Phase 2 context requires an active project contract for session ${sessionId}`,
    );
  }

  const conversationSummary = await storage.getConversationSummary(
    sessionId,
    "phase-2",
  );
  const workflowMap = await storage.getActiveDocument(
    sessionId,
    "workflow_map",
  );
  const screenInventory = await storage.getActiveDocument(
    sessionId,
    "screen_inventory",
  );

  const parts: string[] = [];

  parts.push(`## Project Contract\n${contract.content}`);

  if (conversationSummary) {
    parts.push(
      `## Changes Made So Far in Phase 2\n${conversationSummary.summary}`,
    );
  }

  if (workflowMap) {
    parts.push(
      `## Current Workflow Map\n${buildWorkflowSummary(workflowMap, conversationSummary)}`,
    );
  }

  if (screenInventory) {
    parts.push(
      `## Current Screen Inventory\n${buildScreenSummary(screenInventory, conversationSummary)}`,
    );
  }

  if (screenRef && screenInventory) {
    const detail = getFullScreenDetail(screenInventory, screenRef);
    if (detail) {
      parts.push(`## Currently Viewed Screen (Full Detail)\n${detail}`);

      if (workflowMap) {
        const related = getWorkflowsForScreen(workflowMap, screenRef);
        if (related) {
          parts.push(`## Workflows Touching This Screen\n${related}`);
        }
      }
    }
  }

  return parts.join("\n\n") + "\n";
}

export function buildWorkflowSummary(
  workflowMap: Document,
  conversationSummary: ConversationSummary | null,
): string {
  const parsed = safeParse<WorkflowMapYaml>(workflowMap.structuredData);
  const workflows = parsed?.workflows ?? [];
  if (workflows.length === 0) return "(no workflows)";

  const summaryText = conversationSummary?.summary ?? "";
  return workflows
    .map((wf) => {
      const id = wf.id ?? "(unknown-id)";
      const name = wf.name ?? "(unnamed)";
      const persona = wf.persona ?? "(no persona)";
      const category = wf.category ?? "(no category)";
      const stepCount = wf.steps?.length ?? 0;
      const edgeCount = wf.edgeCases?.length ?? 0;

      let line = `- ${id}: ${name} [persona: ${persona}, category: ${category}, steps: ${stepCount}, edge cases: ${edgeCount}]`;
      if (isRecentlyModified(id, summaryText)) {
        line += " (recently modified)";
      }
      return line;
    })
    .join("\n");
}

export function buildScreenSummary(
  screenInventory: Document,
  conversationSummary: ConversationSummary | null,
): string {
  const parsed = safeParse<ScreenInventoryYaml>(
    screenInventory.structuredData,
  );
  const screens = parsed?.screens ?? [];
  if (screens.length === 0) return "(no screens)";

  const summaryText = conversationSummary?.summary ?? "";
  return screens
    .map((s) => {
      const id = s.id ?? "(unknown-id)";
      const name = s.name ?? "(unnamed)";
      const type = s.type ?? "(no type)";
      const actionCount = s.actions?.length ?? 0;

      let line = `- ${id}: ${name} [type: ${type}, actions: ${actionCount}]`;
      if (isRecentlyModified(id, summaryText)) {
        line += " (recently modified)";
      }
      return line;
    })
    .join("\n");
}

export function getFullScreenDetail(
  screenInventory: Document,
  screenRef: string,
): string | null {
  const parsed = safeParse<ScreenInventoryYaml>(
    screenInventory.structuredData,
  );
  const screen = parsed?.screens?.find((s) => s.id === screenRef);
  if (!screen) return null;

  const lines: string[] = [];
  lines.push(`ID: ${screen.id ?? screenRef}`);
  if (screen.name) lines.push(`Name: ${screen.name}`);
  if (screen.type) lines.push(`Type: ${screen.type}`);
  if (screen.description) lines.push(`Description: ${screen.description}`);
  if (screen.personas && screen.personas.length > 0) {
    lines.push(`Personas: ${screen.personas.join(", ")}`);
  }
  if (screen.workflows && screen.workflows.length > 0) {
    lines.push(`Workflows: ${screen.workflows.join(", ")}`);
  }
  if (screen.actions && screen.actions.length > 0) {
    lines.push(
      `Actions:\n${screen.actions.map((a) => `  - ${a}`).join("\n")}`,
    );
  }
  if (screen.dataDisplayed && screen.dataDisplayed.length > 0) {
    lines.push(
      `Data displayed:\n${screen.dataDisplayed.map((d) => `  - ${d}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}

export function getWorkflowsForScreen(
  workflowMap: Document,
  screenRef: string,
): string | null {
  const parsed = safeParse<WorkflowMapYaml>(workflowMap.structuredData);
  const matches = (parsed?.workflows ?? []).filter((wf) =>
    (wf.steps ?? []).some((step) => step.screen === screenRef),
  );
  if (matches.length === 0) return null;

  return matches
    .map((wf) => {
      const id = wf.id ?? "(unknown-id)";
      const name = wf.name ?? "(unnamed)";
      const persona = wf.persona ?? "(no persona)";
      return `- ${id}: ${name} (persona: ${persona})`;
    })
    .join("\n");
}

function isRecentlyModified(id: string, summaryText: string): boolean {
  // Weak-but-useful heuristic: the id string shows up somewhere in the
  // free-form conversation summary. Sprint 4/7 may replace this with a
  // structured diff if the summary schema evolves, but giving the LLM even
  // this fuzzy "this item was discussed recently" signal is strictly
  // better than no signal at all.
  if (!summaryText) return false;
  return summaryText.includes(id);
}
