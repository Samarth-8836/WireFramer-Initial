import { parse as parseYamlLib } from "yaml";
import { v4 as uuidv4 } from "uuid";

import type { OperationExecutor, SSEWriter } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import {
  executeWorkflowDiscovery,
  executeWorkflowDetailBatch,
  executeWorkflowMapFormatting,
  executeTestCaseGenerationBatch,
  executeEntityCoverageCheck,
  executeTestSuiteFormatting,
  executeScreenExtraction,
  executeNavValidation,
  executeScreenCorrection,
  executeScreenInventoryFormatting,
  executeDummyDataGeneration,
  executeWireframeShell,
  executeScreenHtmlBatch,
  executeWireframeSmokeTest,
  assembleDataFile,
  executeTestHarnessGeneration,
  executeTestTranslationBatch,
  assembleTestBundle,
  executeTestDryRun,
} from "@core/operations/phase2";

import type { AutoGenRunners, AutoGenConditions } from "./auto-generation-graph";
import { buildAutoGenerationGraph } from "./auto-generation-graph";
import { DependencyGraphExecutor } from "./dependency-graph";
import { transitionPhase } from "./phase-state-machine";
import type { Phase2Handlers } from "./session-manager";

interface Phase2Deps {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: IPromptRegistry;
  dataDir: string;
}

// Shared state passed through the DAG via closures.
// Each field is written by one op and read by later ops.
interface ChainState {
  workflowStubs: unknown[];
  detailedWorkflows: string[];
  workflowMapContent: string;
  workflowMapStructuredData: string;
  testCaseBlocks: string[];
  coverageYaml: string;
  testSuiteStructuredData: string;
  screenInventoryYaml: string;
  navValidationStatus: "pass" | "has_issues";
  navFixesYaml: string;
  finalScreenInventoryYaml: string;
  dummyDataJson: string;
  screenIds: string[];
  screenHtmlMap: Map<string, string>;
  smokeTestPassed: boolean;
  translatedTests: string[];
  dryRunHadFailures: boolean;
}

export class Phase2HandlersImpl implements Phase2Handlers {
  private readonly wireframeManager: WireframeManager;

  constructor(private readonly deps: Phase2Deps) {
    this.wireframeManager = new WireframeManager(deps.dataDir);
  }

  // Called by SessionManager when Phase 1 completes and the session
  // transitions to Phase 2. Runs the full auto-generation chain.
  async runAutoGeneration(sessionId: string, sse: SSEWriter): Promise<void> {
    // Initialize Phase 2 state.
    await transitionPhase(
      this.deps.storage,
      sessionId,
      "phase-2",
      "active",
    );
    await this.deps.storage.updateSession(sessionId, {
      currentPhaseId: "phase-2",
    });

    sse.send({
      type: "phase",
      data: { from: "phase-1", to: "phase-2", status: "active" },
    });

    const state: ChainState = {
      workflowStubs: [],
      detailedWorkflows: [],
      workflowMapContent: "",
      workflowMapStructuredData: "",
      testCaseBlocks: [],
      coverageYaml: "",
      testSuiteStructuredData: "",
      screenInventoryYaml: "",
      navValidationStatus: "pass",
      navFixesYaml: "",
      finalScreenInventoryYaml: "",
      dummyDataJson: "",
      screenIds: [],
      screenHtmlMap: new Map(),
      smokeTestPassed: false,
      translatedTests: [],
      dryRunHadFailures: false,
    };

    const runners = this.buildRunners(sessionId, state, sse);
    const conditions = this.buildConditions(state);
    const graph = buildAutoGenerationGraph(runners, conditions);

    const dagExecutor = new DependencyGraphExecutor({
      onProgress: (opId, status) => {
        sse.sendProgress({ operationId: opId, status });
      },
    });

    try {
      await dagExecutor.execute(graph);

      sse.send({
        type: "phase",
        data: {
          phaseId: "phase-2",
          status: "active",
          detail: "Auto-generation complete",
        },
      });
      sse.sendComplete({ event: "auto_generation_complete" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sse.sendError(`Auto-generation chain failed: ${msg}`, true);
      sse.close();
    }
  }

  // Phase 2 conversational — Sprint 7 (drift detection + cascade).
  async handleMessage(
    _sessionId: string,
    _message: string,
    _screenRef: string | null,
    sse: SSEWriter,
  ): Promise<void> {
    sse.sendError(
      "Phase 2 conversational interaction is not yet implemented (Sprint 7).",
      true,
    );
    sse.close();
  }

  // Phase 2 completion — Sprint 10 (export + validation).
  async completePhase(_sessionId: string, sse: SSEWriter): Promise<void> {
    sse.sendError(
      "Phase 2 completion is not yet implemented (Sprint 10).",
      true,
    );
    sse.close();
  }

  // ── Build all 20 DAG runners ─────────────────────────────────

  private buildRunners(
    sessionId: string,
    state: ChainState,
    sse: SSEWriter,
  ): AutoGenRunners {
    const { storage, executor, promptRegistry } = this.deps;
    const wm = this.wireframeManager;

    return {
      // Workflow Map
      "op-2-1a": async () => {
        const result = await executeWorkflowDiscovery(
          executor, promptRegistry, storage, sessionId,
        );
        state.workflowStubs = result.workflows;
      },

      "op-2-1b": async () => {
        const result = await executeWorkflowDetailBatch(
          executor, promptRegistry, storage, sessionId, state.workflowStubs,
        );
        state.detailedWorkflows = result.detailedWorkflows;
      },

      "op-2-1c": async () => {
        const result = await executeWorkflowMapFormatting(
          executor, promptRegistry, state.detailedWorkflows, sessionId,
        );
        state.workflowMapContent = result.content;
        state.workflowMapStructuredData = result.structuredData;

        await storage.createDocument({
          id: uuidv4(),
          sessionId,
          phaseId: "phase-2",
          type: "workflow_map",
          content: result.content,
          structuredData: result.structuredData,
          version: 1,
          status: "active",
          createdAt: new Date().toISOString(),
          lastModifiedAt: new Date().toISOString(),
        });
        sse.sendDocument({
          type: "workflow_map",
          content: result.content,
          version: 1,
        });
      },

      // Test Suite
      "op-2-2a": async () => {
        const result = await executeTestCaseGenerationBatch(
          executor, promptRegistry, storage, sessionId,
          state.detailedWorkflows,
        );
        state.testCaseBlocks = result.testCaseBlocks;
      },

      "op-2-2b": async () => {
        const result = await executeEntityCoverageCheck(
          executor, promptRegistry, storage, sessionId,
          state.workflowMapStructuredData,
        );
        state.coverageYaml = result.coverageYaml;
      },

      "op-2-2c": async () => {
        const result = await executeTestSuiteFormatting(
          executor, promptRegistry,
          state.testCaseBlocks, state.coverageYaml, sessionId,
        );
        state.testSuiteStructuredData = result.structuredData;

        await storage.createDocument({
          id: uuidv4(),
          sessionId,
          phaseId: "phase-2",
          type: "test_suite",
          content: result.content,
          structuredData: result.structuredData,
          version: 1,
          status: "active",
          createdAt: new Date().toISOString(),
          lastModifiedAt: new Date().toISOString(),
        });
        sse.sendDocument({
          type: "test_suite",
          content: result.content,
          version: 1,
        });
      },

      // Screen Inventory
      "op-2-3a": async () => {
        const result = await executeScreenExtraction(
          executor, promptRegistry, storage, sessionId,
          state.workflowMapStructuredData,
        );
        state.screenInventoryYaml = result.screenInventoryYaml;
      },

      "op-2-3b": async () => {
        const result = await executeNavValidation(
          executor, promptRegistry,
          state.screenInventoryYaml,
          state.workflowMapStructuredData,
          sessionId,
        );
        state.navValidationStatus = result.status;
        state.navFixesYaml = result.fixesYaml;
      },

      "op-2-3c": async () => {
        const result = await executeScreenCorrection(
          executor, promptRegistry,
          state.screenInventoryYaml,
          state.navFixesYaml,
          sessionId,
        );
        state.finalScreenInventoryYaml = result.correctedScreenInventoryYaml;
      },

      "op-2-3d": async () => {
        const yaml =
          state.finalScreenInventoryYaml || state.screenInventoryYaml;
        state.finalScreenInventoryYaml = yaml;

        // Extract screen IDs for later ops.
        try {
          const parsed = parseYamlLib(yaml) as Record<string, unknown>;
          const screens = (parsed.screens ?? []) as Record<string, unknown>[];
          state.screenIds = screens.map((s) => s.id as string);
        } catch {
          state.screenIds = [];
        }

        const result = await executeScreenInventoryFormatting(
          executor, promptRegistry, yaml, sessionId,
        );

        await storage.createDocument({
          id: uuidv4(),
          sessionId,
          phaseId: "phase-2",
          type: "screen_inventory",
          content: result.content,
          structuredData: result.structuredData,
          version: 1,
          status: "active",
          createdAt: new Date().toISOString(),
          lastModifiedAt: new Date().toISOString(),
        });
        sse.sendDocument({
          type: "screen_inventory",
          content: result.content,
          version: 1,
        });
      },

      // Wireframe HTML
      "op-2-4a": async () => {
        const result = await executeDummyDataGeneration(
          executor, promptRegistry, storage, sessionId,
          state.workflowMapStructuredData,
        );
        state.dummyDataJson = result.dummyDataJson;
      },

      "op-2-4b": async () => {
        const result = await executeWireframeShell(
          executor, promptRegistry,
          state.finalScreenInventoryYaml,
          sessionId,
        );
        await wm.writeFile(sessionId, "index.html", result.shellHtml);
      },

      "op-2-4c": async () => {
        const result = await executeScreenHtmlBatch(
          executor, promptRegistry,
          state.finalScreenInventoryYaml,
          state.dummyDataJson,
          state.workflowMapStructuredData,
          sessionId,
        );
        state.screenHtmlMap = result.screenHtmlMap;
        for (const [screenId, html] of result.screenHtmlMap) {
          await wm.writeFile(sessionId, `${screenId}.html`, html);
        }
      },

      "op-2-4d": async () => {
        const result = await executeWireframeSmokeTest(
          wm, sessionId, state.screenIds,
        );
        state.smokeTestPassed = result.passed;
        if (!result.passed) {
          console.warn("Wireframe smoke test issues:", result.issues);
        }
      },

      "op-2-4e": async () => {
        const dataJs = assembleDataFile(state.dummyDataJson);
        await wm.writeFile(sessionId, "data.js", dataJs);
      },

      // Automated Tests
      "op-2-5a": async () => {
        const result = await executeTestHarnessGeneration(
          executor, promptRegistry, state.screenIds, sessionId,
        );
        await wm.writeFile(sessionId, "test-harness.html", result.harnessHtml);
      },

      "op-2-5b": async () => {
        const result = await executeTestTranslationBatch(
          executor, promptRegistry, wm, sessionId,
          state.testCaseBlocks,
          state.finalScreenInventoryYaml,
        );
        state.translatedTests = result.translatedTests;
      },

      "op-2-5c": async () => {
        const testsJs = assembleTestBundle(state.translatedTests);
        await wm.writeFile(sessionId, "tests.js", testsJs);
      },

      "op-2-5d": async () => {
        const result = await executeTestDryRun();
        state.dryRunHadFailures = result.results.some(
          (r) => r.status === "fail",
        );
      },

      "op-2-5e": async () => {
        // Placeholder — real repair loop is Sprint 8.
        // The condition prevents this from running when dry run shows no failures.
      },
    };
  }

  private buildConditions(state: ChainState): AutoGenConditions {
    return {
      "op-2-3c": async () => state.navValidationStatus === "has_issues",
      "op-2-5e": async () => state.dryRunHadFailures,
    };
  }
}
