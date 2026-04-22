// Operations 2.5a-2.5e — Automated test generation.
//
// 2.5a: Generate test harness HTML (single AI call).
// 2.5b: Translate test cases to executable steps (batch).
// 2.5c: Bundle test definitions into tests.js (code-only).
// 2.5d: Test dry run placeholder (needs Playwright — deferred to Sprint 8).
// 2.5e: Test repair (conditional, single AI call per failed test).

import { parse as parseYamlLib } from "yaml";

import type { OperationExecutor } from "@core/operation-executor";
import { parseYAML, parsePlainText } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import { PHASE2_PROMPT_SLUGS } from "@core/prompts";
import type { WireframeManager } from "@core/wireframe/wireframe-manager";
import type { OperationDefinition } from "@core/types";

import { executeBatch } from "./batch-utils";

// ── 2.5a — Test Harness Generation ────────────────────────────

export async function executeTestHarnessGeneration(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  screenIds: string[],
  sessionId: string,
): Promise<{ harnessHtml: string }> {
  const def: OperationDefinition = {
    operationId: "op-2-5a",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.testHarness),
    messages: [
      {
        role: "user",
        content: `Generate a test harness for a wireframe with these screens:\n${screenIds.join(", ")}`,
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
    throw new Error(`op-2-5a failed: ${result.error ?? "unknown"}`);
  }

  let html = result.output.rawText.trim();
  if (html.startsWith("```")) {
    html = html.replace(/^```(?:html)?\s*\n?/, "").replace(/\n?```$/, "");
  }

  return { harnessHtml: html };
}

// ── 2.5b — Test Translation (batch) ───────────────────────────

export async function executeTestTranslationBatch(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  wireframeManager: WireframeManager,
  sessionId: string,
  testCaseBlocks: string[],
  screenInventoryYaml: string,
): Promise<{ translatedTests: string[] }> {
  const systemPrompt = registry.get(PHASE2_PROMPT_SLUGS.testTranslation);

  // Collect all screen HTML for reference.
  let screens: Record<string, unknown>[];
  try {
    const parsed = parseYamlLib(screenInventoryYaml) as Record<string, unknown>;
    screens = (parsed.screens ?? []) as Record<string, unknown>[];
  } catch {
    screens = [];
  }

  const screenHtmlCache = new Map<string, string>();
  for (const screen of screens) {
    const id = screen.id as string;
    try {
      const html = await wireframeManager.readFile(sessionId, `${id}.html`);
      screenHtmlCache.set(id, html);
    } catch {
      // Screen file might not exist if generation failed.
    }
  }

  const allScreenHtml = Array.from(screenHtmlCache.entries())
    .map(([id, html]) => `--- Screen: ${id} ---\n${html}`)
    .join("\n\n");

  const results = await executeBatch(testCaseBlocks, async (testYaml) => {
    const def: OperationDefinition = {
      operationId: "op-2-5b",
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Test cases to translate:\n${testYaml}\n\nScreen HTML sources:\n${allScreenHtml}`,
        },
      ],
      expectedOutputFormat: "yaml",
      outputParser: parseYAML,
      maxRetries: 1,
      retryPrompt:
        "Respond with valid YAML test definitions with steps arrays.",
      timeoutMs: 120_000,
      role: "reasoning",
    };

    const result = await executor.execute(def, { sessionId });
    if (result.status === "failed" || !result.output) {
      throw new Error(result.error ?? "test translation failed");
    }
    return result.output.rawText;
  });

  if (results.failed.length > 0) {
    console.warn(
      `op-2-5b: ${results.failed.length} test block(s) failed translation`,
    );
  }

  // No translated tests → tests.js would be empty → dry run finds
  // nothing to run → stage would "succeed" with zero coverage. Fail.
  if (results.succeeded.length === 0 && results.failed.length > 0) {
    const firstError = results.failed[0]?.error ?? "unknown error";
    throw new Error(
      `op-2-5b failed on all ${results.failed.length} test block(s). First error: ${firstError}`,
    );
  }

  return {
    translatedTests: results.succeeded.map((s) => s.result as string),
  };
}

// ── 2.5c — Test Bundle Assembly (code-only) ───────────────────

export function assembleTestBundle(translatedTests: string[]): string {
  // Parse each translated YAML block and collect all test definitions.
  const allTests: unknown[] = [];

  for (const yaml of translatedTests) {
    try {
      const parsed = parseYamlLib(yaml) as Record<string, unknown>;
      const tests = (parsed.tests ?? []) as unknown[];
      allTests.push(...tests);
    } catch {
      // Skip blocks that fail to parse.
    }
  }

  return `const TEST_DEFINITIONS = ${JSON.stringify(allTests, null, 2)};\n`;
}

// ── 2.5d — Test Dry Run (placeholder) ─────────────────────────
//
// Real implementation needs Playwright (Sprint 8). For Sprint 6 we
// record the step as "skipped — no Playwright" so the chain completes.

export interface DryRunResult {
  executed: boolean;
  results: { id: string; name: string; status: "pass" | "fail" | "skipped" }[];
}

export async function executeTestDryRun(): Promise<DryRunResult> {
  // Sprint 8 will implement the real Playwright-based dry run.
  return {
    executed: false,
    results: [],
  };
}

// ── 2.5e — Test Repair (conditional) ──────────────────────────

export async function executeTestRepair(
  executor: OperationExecutor,
  registry: IPromptRegistry,
  wireframeManager: WireframeManager,
  sessionId: string,
  failedTest: { definition: string; failedStep: string; error: string; screenId: string },
): Promise<{ fixedTestYaml: string }> {
  let screenHtml = "";
  try {
    screenHtml = await wireframeManager.readFile(
      sessionId,
      `${failedTest.screenId}.html`,
    );
  } catch {
    screenHtml = "(screen HTML not available)";
  }

  const def: OperationDefinition = {
    operationId: "op-2-5e",
    systemPrompt: registry.get(PHASE2_PROMPT_SLUGS.testRepair),
    messages: [
      {
        role: "user",
        content: `Failed test definition:\n${failedTest.definition}\n\nFailed step: ${failedTest.failedStep}\nError: ${failedTest.error}\n\nScreen HTML where failure occurred:\n${screenHtml}`,
      },
    ],
    expectedOutputFormat: "yaml",
    outputParser: parseYAML,
    maxRetries: 1,
    retryPrompt:
      "Respond with the COMPLETE fixed test definition in YAML format.",
    timeoutMs: 120_000,
    role: "reasoning",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    throw new Error(`op-2-5e failed: ${result.error ?? "unknown"}`);
  }

  return { fixedTestYaml: result.output.rawText };
}
