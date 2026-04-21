// Operations 2.4a-2.4e — Wireframe HTML generation.
//
// 2.4a: Generate dummy data (single AI call → JSON).
// 2.4b: Generate wireframe shell (single AI call → HTML).
// 2.4c: Generate screen HTML (batch — one AI call per screen).
// 2.4d: Smoke test (code-only — verify file structure).
// 2.4e: Data file assembly (code-only — wrap JSON as data.js).

import { parse as parseYamlLib } from "yaml";

import type { OperationExecutor } from "@core/operation-executor";
import { parseJSON, parsePlainText } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import type { OperationDefinition } from "@core/types";

import { executeBatch } from "./batch-utils";

// ── 2.4a — Dummy Data Generation ──────────────────────────────

export async function executeDummyDataGeneration(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  storage: IStorage,
  sessionId: string,
  workflowMapStructuredData: string,
): Promise<{ dummyDataJson: string }> {
  const contract = await getActiveContract(storage, sessionId);

  const def: OperationDefinition = {
    operationId: "op-2-4a",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.dummyDataGeneration),
    messages: [
      {
        role: "user",
        content: `Product entity map (from contract):\n${contract}\n\nWorkflow references:\n${workflowMapStructuredData}`,
      },
    ],
    expectedOutputFormat: "json",
    outputParser: parseJSON,
    maxRetries: 1,
    retryPrompt: "Respond with valid JSON only. No markdown, no explanation.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-4a failed: ${result.error ?? "unknown"}`);
  }

  return { dummyDataJson: result.output.rawText };
}

// ── 2.4b — Wireframe Shell Generation ─────────────────────────

export async function executeWireframeShell(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  screenInventoryYaml: string,
  sessionId: string,
): Promise<{ shellHtml: string }> {
  // Extract screen list summary for the prompt.
  let screenListText: string;
  try {
    const parsed = parseYamlLib(screenInventoryYaml) as Record<string, unknown>;
    const screens = (parsed.screens ?? []) as Record<string, unknown>[];
    const entryScreen = screens.find(
      (s) => s.entry_point === true,
    );
    const screenLines = screens.map(
      (s) => `- ${s.id}: ${s.name} (type: ${s.type})`,
    );
    screenListText = screenLines.join("\n");
    if (entryScreen) {
      screenListText += `\n\nThe entry point screen is: ${entryScreen.id}`;
    }
  } catch {
    screenListText = screenInventoryYaml;
  }

  const basePrompt = registry.get(PHASE2_PROMPT_SLUGS.wireframeShell);
  const fullPrompt = basePrompt.replace(
    "[list of screen IDs, names, and types]",
    screenListText,
  );

  const def: OperationDefinition = {
    operationId: "op-2-4b",
    systemPrompt: fullPrompt,
    messages: [
      {
        role: "user",
        content: `Generate the index.html wireframe shell for these screens:\n\n${screenListText}`,
      },
    ],
    expectedOutputFormat: "plain_text",
    outputParser: parsePlainText,
    maxRetries: 1,
    retryPrompt: "Respond with complete HTML only. No markdown fences.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-4b failed: ${result.error ?? "unknown"}`);
  }

  // Strip any markdown code fences the model might add.
  let html = result.output.rawText.trim();
  if (html.startsWith("```")) {
    html = html.replace(/^```(?:html)?\s*\n?/, "").replace(/\n?```$/, "");
  }

  return { shellHtml: html };
}

// ── 2.4c — Screen HTML Generation (batch) ─────────────────────

export async function executeScreenHtmlBatch(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  screenInventoryYaml: string,
  dummyDataJson: string,
  workflowMapStructuredData: string,
  sessionId: string,
): Promise<{ screenHtmlMap: Map<string, string> }> {
  let screens: Record<string, unknown>[];
  try {
    const parsed = parseYamlLib(screenInventoryYaml) as Record<string, unknown>;
    screens = (parsed.screens ?? []) as Record<string, unknown>[];
  } catch {
    throw new Error("Failed to parse screen inventory YAML for batch HTML gen");
  }

  const systemPrompt = registry.get(PHASE2_PROMPT_SLUGS.screenHtmlGeneration);
  const screenHtmlMap = new Map<string, string>();

  const results = await executeBatch(screens, async (screen) => {
    const screenId = screen.id as string;
    const screenYaml = JSON.stringify(screen, null, 2);

    const def: OperationDefinition = {
      operationId: "op-2-4c",
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate HTML for this screen:\n\n${screenYaml}\n\nDummy data (use this for content):\n${dummyDataJson}\n\nWorkflow context:\n${workflowMapStructuredData}`,
        },
      ],
      expectedOutputFormat: "plain_text",
      outputParser: parsePlainText,
      maxRetries: 1,
      retryPrompt: "Respond with complete HTML only. No markdown fences.",
      timeoutMs: 120_000,
      role: "reasoning",
    };

    const result = await executor.execute(def, { sessionId });
    if (result.status === "failed" || !result.output) {
      throw new Error(result.error ?? "screen HTML generation failed");
    }

    let html = result.output.rawText.trim();
    if (html.startsWith("```")) {
      html = html.replace(/^```(?:html)?\s*\n?/, "").replace(/\n?```$/, "");
    }

    screenHtmlMap.set(screenId, html);
    return html;
  });

  if (results.failed.length > 0) {
    console.warn(
      `op-2-4c: ${results.failed.length} screen(s) failed HTML gen`,
    );
  }

  return { screenHtmlMap };
}

// ── 2.4d — Wireframe Smoke Test (code-only) ───────────────────

export interface SmokeTestResult {
  passed: boolean;
  issues: string[];
}

export async function executeWireframeSmokeTest(
  wireframeManager: WireframeManager,
  sessionId: string,
  screenIds: string[],
): Promise<SmokeTestResult> {
  const issues: string[] = [];

  // Check shell exists.
  try {
    await wireframeManager.readFile(sessionId, "index.html");
  } catch {
    issues.push("Missing index.html (wireframe shell)");
  }

  // Check data.js exists.
  try {
    await wireframeManager.readFile(sessionId, "data.js");
  } catch {
    issues.push("Missing data.js");
  }

  // Check each screen file exists.
  for (const id of screenIds) {
    try {
      await wireframeManager.readFile(sessionId, `${id}.html`);
    } catch {
      issues.push(`Missing screen file: ${id}.html`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

// ── 2.4e — Data File Assembly (code-only) ─────────────────────

export function assembleDataFile(dummyDataJson: string): string {
  // Ensure the JSON is valid before wrapping.
  let cleaned = dummyDataJson.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```$/, "");
  }
  return `const DUMMY_DATA = ${cleaned};\n`;
}

// ── helpers ────────────────────────────────────────────────────

async function getActiveContract(
  storage: IStorage,
  sessionId: string,
): Promise<string> {
  const docs = await storage.getDocumentsBySession(sessionId);
  const contract = docs.find(
    (d) => d.type === "project_contract" && d.status === "active",
  );
  if (!contract) throw new Error("No active project contract found");
  return contract.content;
}
