// Cascade Executor — orchestrates the regeneration of artifacts after
// a Phase 2 user change. Routes through one of three paths based on
// the cascade scope (data_only | screen_only | workflow_change).

import { v4 as uuidv4 } from "uuid";
import { parse as parseYamlLib } from "yaml";

import type { OperationExecutor, SSEWriter } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import {
  executeDummyDataGeneration,
  assembleDataFile,
  executeTargetedScreenUpdate,
  executeTargetedWorkflowUpdate,
  executeScreenHtmlBatch,
  executeWireframeShell,
  executeWorkflowMapFormatting,
  executeTestCaseGenerationBatch,
  executeTestSuiteFormatting,
  executeEntityCoverageCheck,
  executeScreenInventoryFormatting,
  executeTestTranslationBatch,
  assembleTestBundle,
} from "@core/operations/phase2";

import type { CascadeRoute } from "./cascade-router";

interface CascadeDeps {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: IPromptRegistry;
  dataDir: string;
}

export class CascadeExecutor {
  private readonly wireframeManager: WireframeManager;

  constructor(private readonly deps: CascadeDeps) {
    this.wireframeManager = new WireframeManager(deps.dataDir);
  }

  async execute(
    sessionId: string,
    route: CascadeRoute,
    sse: SSEWriter,
  ): Promise<void> {
    // Create a cascade snapshot for potential undo (Sprint 9).
    await this.createCascadeSnapshot(sessionId);

    switch (route.scope) {
      case "data_only":
        await this.executeDataOnly(sessionId, route, sse);
        break;
      case "screen_only":
        await this.executeScreenOnly(sessionId, route, sse);
        break;
      case "workflow_change":
        await this.executeWorkflowChange(sessionId, route, sse);
        break;
    }

    // Update conversation summary.
    await this.deps.storage.upsertConversationSummary({
      sessionId,
      phaseId: "phase-2",
      summary: `Applied ${route.scope} change: ${route.description}`,
      lastUpdatedAt: new Date().toISOString(),
      messagesCovered: 1,
    });
  }

  // ── data_only (~1 AI call) ──────────────────────────────────

  private async executeDataOnly(
    sessionId: string,
    route: CascadeRoute,
    sse: SSEWriter,
  ): Promise<void> {
    const { executor, promptRegistry, storage } = this.deps;

    sse.sendProgress({
      operationId: "cascade-data",
      status: "in_progress",
      detail: "Regenerating dummy data",
    });

    const workflowMap = await this.getDocumentStructuredData(
      sessionId,
      "workflow_map",
    );

    const result = await executeDummyDataGeneration(
      executor, promptRegistry, storage, sessionId, workflowMap,
    );

    const dataJs = assembleDataFile(result.dummyDataJson);
    await this.wireframeManager.writeFile(sessionId, "data.js", dataJs);

    sse.sendProgress({
      operationId: "cascade-data",
      status: "complete",
      detail: "Dummy data regenerated",
    });
  }

  // ── screen_only (~4-8 AI calls) ─────────────────────────────

  private async executeScreenOnly(
    sessionId: string,
    route: CascadeRoute,
    sse: SSEWriter,
  ): Promise<void> {
    const { executor, promptRegistry, storage } = this.deps;
    const wm = this.wireframeManager;

    const workflowMap = await this.getDocumentStructuredData(
      sessionId,
      "workflow_map",
    );
    const currentScreenYaml = await this.getDocumentStructuredData(
      sessionId,
      "screen_inventory",
    );

    // 2.7c — Update screen inventory.
    sse.sendProgress({
      operationId: "op-2-7c",
      status: "in_progress",
      detail: "Updating screen inventory",
    });

    const screenChanges = JSON.stringify(
      route.changeContext.screen_changes ?? [],
      null,
      2,
    );
    const { updatedScreenInventoryYaml } = await executeTargetedScreenUpdate(
      executor,
      promptRegistry,
      currentScreenYaml,
      screenChanges,
      workflowMap,
      sessionId,
    );

    sse.sendProgress({ operationId: "op-2-7c", status: "complete" });

    // Get dummy data for screen regeneration.
    const dummyDataJson = await this.getDummyDataJson(sessionId);

    // Extract screen IDs from updated inventory.
    const screenIds = this.extractScreenIds(updatedScreenInventoryYaml);

    // Regenerate affected screen HTML.
    sse.sendProgress({
      operationId: "op-2-4c",
      status: "in_progress",
      detail: "Regenerating screen HTML",
    });

    const { screenHtmlMap } = await executeScreenHtmlBatch(
      executor, promptRegistry,
      updatedScreenInventoryYaml, dummyDataJson, workflowMap, sessionId,
    );
    for (const [screenId, html] of screenHtmlMap) {
      await wm.writeFile(sessionId, `${screenId}.html`, html);
    }

    sse.sendProgress({ operationId: "op-2-4c", status: "complete" });

    // Update shell if screen list changed.
    sse.sendProgress({ operationId: "op-2-4b", status: "in_progress" });
    const { shellHtml } = await executeWireframeShell(
      executor, promptRegistry, updatedScreenInventoryYaml, sessionId,
    );
    await wm.writeFile(sessionId, "index.html", shellHtml);
    sse.sendProgress({ operationId: "op-2-4b", status: "complete" });

    // Reformat screen inventory document.
    const formatted = await executeScreenInventoryFormatting(
      executor, promptRegistry, updatedScreenInventoryYaml, sessionId,
    );
    await this.updateDocument(
      sessionId,
      "screen_inventory",
      formatted.content,
      formatted.structuredData,
    );
    sse.sendDocument({
      type: "screen_inventory",
      content: formatted.content,
      version: 2,
    });

    // Re-translate tests.
    await this.retranslateTests(sessionId, workflowMap, updatedScreenInventoryYaml, sse);
  }

  // ── workflow_change (~9-21 AI calls) ────────────────────────

  private async executeWorkflowChange(
    sessionId: string,
    route: CascadeRoute,
    sse: SSEWriter,
  ): Promise<void> {
    const { executor, promptRegistry, storage } = this.deps;
    const wm = this.wireframeManager;

    const workflowMap = await this.getDocumentStructuredData(
      sessionId,
      "workflow_map",
    );

    // 2.7d — Update affected workflows.
    const workflowChanges =
      (route.changeContext.workflow_changes as Record<string, unknown>[]) ?? [];

    sse.sendProgress({
      operationId: "op-2-7d",
      status: "in_progress",
      detail: `Updating ${workflowChanges.length} workflow(s)`,
    });

    const updatedWorkflows: string[] = [];
    for (const wc of workflowChanges) {
      const { updatedWorkflowYaml } = await executeTargetedWorkflowUpdate(
        executor,
        promptRegistry,
        storage,
        sessionId,
        workflowMap,
        JSON.stringify(wc, null, 2),
      );
      updatedWorkflows.push(updatedWorkflowYaml);
    }

    sse.sendProgress({ operationId: "op-2-7d", status: "complete" });

    // Regenerate workflow map document.
    sse.sendProgress({ operationId: "op-2-1c", status: "in_progress" });
    const wfFormatted = await executeWorkflowMapFormatting(
      executor, promptRegistry, updatedWorkflows, sessionId,
    );
    await this.updateDocument(
      sessionId,
      "workflow_map",
      wfFormatted.content,
      wfFormatted.structuredData,
    );
    sse.sendDocument({
      type: "workflow_map",
      content: wfFormatted.content,
      version: 2,
    });
    sse.sendProgress({ operationId: "op-2-1c", status: "complete" });

    // Regenerate test cases.
    sse.sendProgress({ operationId: "op-2-2a", status: "in_progress" });
    const { testCaseBlocks } = await executeTestCaseGenerationBatch(
      executor, promptRegistry, storage, sessionId, updatedWorkflows,
    );
    sse.sendProgress({ operationId: "op-2-2a", status: "complete" });

    // Entity coverage.
    const { coverageYaml } = await executeEntityCoverageCheck(
      executor, promptRegistry, storage, sessionId,
      wfFormatted.structuredData,
    );

    // Reformat test suite.
    sse.sendProgress({ operationId: "op-2-2c", status: "in_progress" });
    const tsFormatted = await executeTestSuiteFormatting(
      executor, promptRegistry, testCaseBlocks, coverageYaml, sessionId,
    );
    await this.updateDocument(
      sessionId,
      "test_suite",
      tsFormatted.content,
      tsFormatted.structuredData,
    );
    sse.sendDocument({
      type: "test_suite",
      content: tsFormatted.content,
      version: 2,
    });
    sse.sendProgress({ operationId: "op-2-2c", status: "complete" });

    // Update screens if needed.
    const screenChanges = route.changeContext.screen_changes as
      | Record<string, unknown>[]
      | undefined;
    const currentScreenYaml = await this.getDocumentStructuredData(
      sessionId,
      "screen_inventory",
    );

    let finalScreenYaml = currentScreenYaml;
    if (screenChanges && screenChanges.length > 0) {
      sse.sendProgress({ operationId: "op-2-7c", status: "in_progress" });
      const { updatedScreenInventoryYaml } =
        await executeTargetedScreenUpdate(
          executor,
          promptRegistry,
          currentScreenYaml,
          JSON.stringify(screenChanges, null, 2),
          wfFormatted.structuredData,
          sessionId,
        );
      finalScreenYaml = updatedScreenInventoryYaml;
      sse.sendProgress({ operationId: "op-2-7c", status: "complete" });
    }

    // Regenerate HTML.
    const dummyDataJson = await this.getDummyDataJson(sessionId);

    sse.sendProgress({ operationId: "op-2-4c", status: "in_progress" });
    const { screenHtmlMap } = await executeScreenHtmlBatch(
      executor, promptRegistry,
      finalScreenYaml, dummyDataJson, wfFormatted.structuredData, sessionId,
    );
    for (const [screenId, html] of screenHtmlMap) {
      await wm.writeFile(sessionId, `${screenId}.html`, html);
    }
    sse.sendProgress({ operationId: "op-2-4c", status: "complete" });

    // Update shell.
    const { shellHtml } = await executeWireframeShell(
      executor, promptRegistry, finalScreenYaml, sessionId,
    );
    await wm.writeFile(sessionId, "index.html", shellHtml);

    // Reformat screen inventory.
    const siFormatted = await executeScreenInventoryFormatting(
      executor, promptRegistry, finalScreenYaml, sessionId,
    );
    await this.updateDocument(
      sessionId,
      "screen_inventory",
      siFormatted.content,
      siFormatted.structuredData,
    );
    sse.sendDocument({
      type: "screen_inventory",
      content: siFormatted.content,
      version: 2,
    });

    // Re-translate tests.
    await this.retranslateTests(
      sessionId,
      wfFormatted.structuredData,
      finalScreenYaml,
      sse,
    );
  }

  // ── shared helpers ──────────────────────────────────────────

  private async retranslateTests(
    sessionId: string,
    workflowMapStructuredData: string,
    screenInventoryYaml: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { executor, promptRegistry } = this.deps;
    const wm = this.wireframeManager;

    // Get test case blocks from test suite document.
    const testSuiteData = await this.getDocumentStructuredData(
      sessionId,
      "test_suite",
    );
    const testCaseBlocks = testSuiteData
      ? testSuiteData.split("\n---\n")
      : [];

    if (testCaseBlocks.length === 0) return;

    sse.sendProgress({ operationId: "op-2-5b", status: "in_progress" });
    const { translatedTests } = await executeTestTranslationBatch(
      executor, promptRegistry, wm, sessionId,
      testCaseBlocks, screenInventoryYaml,
    );

    const testsJs = assembleTestBundle(translatedTests);
    await wm.writeFile(sessionId, "tests.js", testsJs);
    sse.sendProgress({ operationId: "op-2-5b", status: "complete" });
  }

  private async getDocumentStructuredData(
    sessionId: string,
    type: string,
  ): Promise<string> {
    const docs = await this.deps.storage.getDocumentsBySession(sessionId);
    const doc = docs.find(
      (d) => d.type === type && d.status === "active",
    );
    return doc?.structuredData ?? "";
  }

  private async getDummyDataJson(sessionId: string): Promise<string> {
    try {
      const dataJs = await this.wireframeManager.readFile(
        sessionId,
        "data.js",
      );
      // Strip the "const DUMMY_DATA = " wrapper.
      const match = dataJs.match(
        /const DUMMY_DATA\s*=\s*([\s\S]+?);?\s*$/,
      );
      return match?.[1] ?? "{}";
    } catch {
      return "{}";
    }
  }

  private async updateDocument(
    sessionId: string,
    type: string,
    content: string,
    structuredData: string,
  ): Promise<void> {
    await this.deps.storage.createDocument({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-2",
      type: type as import("@core/types").DocumentType,
      content,
      structuredData,
      version: 1, // Storage auto-bumps + deactivates old.
      status: "active",
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    });
  }

  private async createCascadeSnapshot(sessionId: string): Promise<void> {
    // Sprint 9 will implement full snapshot logic with real document/artifact
    // captures. For now, create a minimal record so the cascade is tracked.
    await this.deps.storage.createCascadeSnapshot({
      id: uuidv4(),
      sessionId,
      triggeredBy: "cascade",
      createdAt: new Date().toISOString(),
      documentSnapshots: [],
      artifactSnapshots: [],
      status: "active",
    });
  }

  private extractScreenIds(screenInventoryYaml: string): string[] {
    try {
      const parsed = parseYamlLib(screenInventoryYaml) as Record<
        string,
        unknown
      >;
      const screens = (parsed.screens ?? []) as Record<string, unknown>[];
      return screens.map((s) => s.id as string);
    } catch {
      return [];
    }
  }
}
