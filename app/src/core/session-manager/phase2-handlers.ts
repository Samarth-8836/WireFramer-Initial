import { parse as parseYamlLib } from "yaml";
import { v4 as uuidv4 } from "uuid";

import type { ContextBuilder } from "@core/context-builder";
import type { OperationExecutor, SSEWriter } from "@core/operation-executor";
import type { IPromptRegistry } from "@core/prompts";
import type { IStorage } from "@core/storage";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import {
  executeDriftCheck,
  executePhase2Conversational,
  validatePhase2,
} from "@core/operations/phase2";
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
import type { Phase2Stage } from "@core/types";

import { CascadeExecutor } from "./cascade-executor";
import { routeCascade } from "./cascade-router";
import { DependencyGraphExecutor } from "./dependency-graph";
import type { GraphNode } from "./dependency-graph";
import { transitionPhase } from "./phase-state-machine";
import {
  canAdvanceStage,
  setPhase2Stage,
  stageAfterRunning,
} from "./phase2-stage-machine";
import type { Phase2Handlers } from "./session-manager";

interface Phase2Deps {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: IPromptRegistry;
  contextBuilder: ContextBuilder;
  dataDir: string;
}

// Each stage has its own ephemeral state bag — the DAG nodes within a
// stage read/write it via closure. Intermediate values that the NEXT
// stage needs (e.g. the detailed workflow YAMLs that Op 2.2a consumes)
// are recovered from the persisted `*.structuredData` documents at the
// start of the next stage, so no state has to survive between stage
// runs.
interface DesignStageState {
  workflowStubs: unknown[];
  detailedWorkflows: string[];
  workflowMapContent: string;
  workflowMapStructuredData: string;
  screenInventoryYaml: string;
  navValidationStatus: "pass" | "has_issues";
  navFixesYaml: string;
  finalScreenInventoryYaml: string;
  screenIds: string[];
}

interface WireframeStageState {
  workflowMapStructuredData: string;
  finalScreenInventoryYaml: string;
  screenIds: string[];
  dummyDataJson: string;
  screenHtmlMap: Map<string, string>;
  smokeTestPassed: boolean;
}

interface TestSuiteStageState {
  detailedWorkflows: string[];
  workflowMapStructuredData: string;
  testCaseBlocks: string[];
  coverageYaml: string;
  testSuiteStructuredData: string;
}

interface AutomatedTestsStageState {
  screenIds: string[];
  finalScreenInventoryYaml: string;
  testCaseBlocks: string[];
  translatedTests: string[];
  dryRunHadFailures: boolean;
}

export class Phase2HandlersImpl implements Phase2Handlers {
  private readonly wireframeManager: WireframeManager;

  constructor(private readonly deps: Phase2Deps) {
    this.wireframeManager = new WireframeManager(deps.dataDir);
  }

  // Entry point called by SessionManager.completePhase after Phase 1
  // PASSes. Initializes Phase 2 state (phase-2 → active, phase2Stage set)
  // then runs Stage 1 (design). Subsequent stages are gated behind user
  // approval via `advanceStage()`.
  async runAutoGeneration(sessionId: string, sse: SSEWriter): Promise<void> {
    try {
      await this.initializePhase2(sessionId, sse);
      await this.runDesignStage(sessionId, sse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sse.sendError(`Phase 2 design stage failed: ${msg}`, true);
      sse.close();
    }
  }

  // Called by /api/phase2/advance when the user clicks "Approve" on the
  // current stage's review. Dispatches to the next stage runner based
  // on the session's current phase2Stage.
  async advanceStage(sessionId: string, sse: SSEWriter): Promise<void> {
    const { storage } = this.deps;

    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        sse.sendError(`Session ${sessionId} not found.`, true);
        sse.close();
        return;
      }

      const current = session.phase2Stage ?? "not_started";
      const { ok, next, reason } = canAdvanceStage(current);
      if (!ok || !next) {
        sse.sendError(reason ?? "Cannot advance stage.", true);
        sse.close();
        return;
      }

      switch (next) {
        case "wireframe_running":
          await this.runWireframeStage(sessionId, sse);
          return;
        case "test_suite_running":
          await this.runTestSuiteStage(sessionId, sse);
          return;
        case "automated_tests_running":
          await this.runAutomatedTestsStage(sessionId, sse);
          return;
        default:
          sse.sendError(
            `Unexpected next stage: ${next}. This is a bug.`,
            true,
          );
          sse.close();
          return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sse.sendError(`Stage advance failed: ${msg}`, true);
      sse.close();
    }
  }

  // Phase 2 conversational — full drift detection + cascade flow.
  async handleMessage(
    sessionId: string,
    message: string,
    screenRef: string | null,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage, executor, contextBuilder, promptRegistry, dataDir } =
      this.deps;

    // 1. Op 2.7a — Conversational AI.
    const conversational = await executePhase2Conversational(
      executor,
      contextBuilder,
      sessionId,
      message,
      screenRef,
      sse,
    );

    // Persist user + assistant messages.
    await storage.addMessage({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-2",
      role: "user",
      type: "chat",
      content: message,
      metadata: {
        screenReference: screenRef,
        generationContext: null,
        operationId: "op-2-7a",
        stale: false,
      },
      createdAt: new Date().toISOString(),
    });

    await storage.addMessage({
      id: uuidv4(),
      sessionId,
      phaseId: "phase-2",
      role: "assistant",
      type: "chat",
      content: conversational.visibleResponse,
      metadata: {
        screenReference: null,
        generationContext: conversational.changeContextRaw,
        operationId: "op-2-7a",
        stale: false,
      },
      createdAt: new Date().toISOString(),
    });

    // 2. If clarifying question — stop here.
    if (conversational.isClarifyingQuestion) {
      sse.sendComplete({ event: "clarifying_question" });
      return;
    }

    // 3. Op 2.6 — Drift check.
    if (conversational.changeContextRaw) {
      const driftResult = await executeDriftCheck(
        executor,
        contextBuilder,
        sessionId,
        conversational.changeContextRaw,
      );

      if (driftResult.classification === "DRIFT") {
        sse.send({
          type: "drift",
          data: {
            classification: "DRIFT",
            type: driftResult.type,
            reason: driftResult.reason,
          },
        });
        sse.sendComplete({ event: "drift_blocked" });
        return;
      }

      if (driftResult.classification === "FLAG") {
        sse.send({
          type: "drift",
          data: {
            classification: "FLAG",
            type: driftResult.type,
            reason: driftResult.reason,
          },
        });
        // Proceed anyway — UI shows a warning banner.
      }
    }

    // 4. Op 2.7b — Cascade routing.
    if (!conversational.changeContextParsed) {
      sse.sendComplete({ event: "no_changes" });
      return;
    }

    const route = routeCascade(conversational.changeContextParsed);

    sse.sendProgress({
      operationId: "cascade",
      status: "in_progress",
      detail: `Applying ${route.scope} change: ${route.description}`,
    });

    const cascadeExecutor = new CascadeExecutor({
      storage,
      executor,
      promptRegistry,
      dataDir,
    });

    await cascadeExecutor.execute(sessionId, route, sse);

    sse.sendProgress({
      operationId: "cascade",
      status: "complete",
      detail: "Changes applied",
    });

    sse.sendComplete({ event: "cascade_complete" });
  }

  // Phase 2 completion — runs Op 2.10 validation. On PASS, transitions
  // phase-2 → completing → complete. On FAIL, stays active with issues.
  async completePhase(sessionId: string, sse: SSEWriter): Promise<void> {
    const { storage, executor, promptRegistry } = this.deps;

    sse.sendProgress({
      operationId: "op-2-10",
      status: "in_progress",
      detail: "Validating Phase 2 artifacts",
    });

    try {
      const result = await validatePhase2(
        executor,
        promptRegistry,
        storage,
        this.wireframeManager,
        sessionId,
      );

      const validationMessage = this.formatPhase2ValidationMessage(result);
      await storage.addMessage({
        id: uuidv4(),
        sessionId,
        phaseId: "phase-2",
        role: "system",
        type: "validation_result",
        content: validationMessage,
        metadata: {
          screenReference: null,
          generationContext: null,
          operationId: "op-2-10",
          stale: false,
        },
        createdAt: new Date().toISOString(),
      });

      if (result.overall === "PASS") {
        await transitionPhase(storage, sessionId, "phase-2", "completing");
        await transitionPhase(storage, sessionId, "phase-2", "complete");
        sse.send({
          type: "phase",
          data: { phaseId: "phase-2", status: "complete" },
        });
      } else {
        sse.send({
          type: "phase",
          data: { phaseId: "phase-2", status: "active" },
        });
      }

      const issues = [
        ...result.codeChecks.failures,
        ...(result.aiValidation?.issues ?? []),
      ];
      const suggestions = result.aiValidation?.suggestions ?? [];

      sse.send({
        type: "test_results",
        data: {
          status: result.overall,
          issues,
          suggestions,
          warnings: result.aiValidation?.warnings ?? [],
        },
      });

      sse.sendComplete({ validation: result.overall });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sse.sendError(`Phase 2 validation failed: ${message}`, true);
      sse.close();
    }
  }

  // ── Stage runners ───────────────────────────────────────────

  // Stage 1: Design — Workflow Map + Screen Inventory.
  // Ops: 2.1a, 2.1b, 2.1c, 2.3a, 2.3b, 2.3c (conditional), 2.3d.
  private async runDesignStage(
    sessionId: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage, executor, promptRegistry } = this.deps;

    await setPhase2Stage(storage, sessionId, "design_running");
    sse.sendStage({ stageName: "design", status: "running" });

    const state: DesignStageState = {
      workflowStubs: [],
      detailedWorkflows: [],
      workflowMapContent: "",
      workflowMapStructuredData: "",
      screenInventoryYaml: "",
      navValidationStatus: "pass",
      navFixesYaml: "",
      finalScreenInventoryYaml: "",
      screenIds: [],
    };

    const nodes: GraphNode[] = [
      {
        operationId: "op-2-1a",
        dependencies: [],
        execute: async () => {
          const r = await executeWorkflowDiscovery(
            executor,
            promptRegistry,
            storage,
            sessionId,
          );
          state.workflowStubs = r.workflows;
        },
      },
      {
        operationId: "op-2-1b",
        dependencies: ["op-2-1a"],
        execute: async () => {
          const r = await executeWorkflowDetailBatch(
            executor,
            promptRegistry,
            storage,
            sessionId,
            state.workflowStubs,
          );
          state.detailedWorkflows = r.detailedWorkflows;
        },
      },
      {
        operationId: "op-2-1c",
        dependencies: ["op-2-1b"],
        execute: async () => {
          const r = await executeWorkflowMapFormatting(
            executor,
            promptRegistry,
            state.detailedWorkflows,
            sessionId,
          );
          state.workflowMapContent = r.content;
          state.workflowMapStructuredData = r.structuredData;

          await storage.createDocument({
            id: uuidv4(),
            sessionId,
            phaseId: "phase-2",
            type: "workflow_map",
            content: r.content,
            structuredData: r.structuredData,
            version: 1,
            status: "active",
            createdAt: new Date().toISOString(),
            lastModifiedAt: new Date().toISOString(),
          });
          sse.sendDocument({
            type: "workflow_map",
            content: r.content,
            version: 1,
          });
        },
      },
      {
        operationId: "op-2-3a",
        dependencies: ["op-2-1c"],
        execute: async () => {
          const r = await executeScreenExtraction(
            executor,
            promptRegistry,
            storage,
            sessionId,
            state.workflowMapStructuredData,
          );
          state.screenInventoryYaml = r.screenInventoryYaml;
        },
      },
      {
        operationId: "op-2-3b",
        dependencies: ["op-2-3a"],
        execute: async () => {
          const r = await executeNavValidation(
            executor,
            promptRegistry,
            state.screenInventoryYaml,
            state.workflowMapStructuredData,
            sessionId,
          );
          state.navValidationStatus = r.status;
          state.navFixesYaml = r.fixesYaml;
        },
      },
      {
        operationId: "op-2-3c",
        dependencies: ["op-2-3b"],
        condition: async () => state.navValidationStatus === "has_issues",
        execute: async () => {
          const r = await executeScreenCorrection(
            executor,
            promptRegistry,
            state.screenInventoryYaml,
            state.navFixesYaml,
            sessionId,
          );
          state.finalScreenInventoryYaml = r.correctedScreenInventoryYaml;
        },
      },
      {
        operationId: "op-2-3d",
        dependencies: ["op-2-3c"],
        execute: async () => {
          const yaml =
            state.finalScreenInventoryYaml || state.screenInventoryYaml;
          state.finalScreenInventoryYaml = yaml;
          state.screenIds = extractScreenIdsFromYaml(yaml);

          const r = await executeScreenInventoryFormatting(
            executor,
            promptRegistry,
            yaml,
            sessionId,
          );

          await storage.createDocument({
            id: uuidv4(),
            sessionId,
            phaseId: "phase-2",
            type: "screen_inventory",
            content: r.content,
            structuredData: r.structuredData,
            version: 1,
            status: "active",
            createdAt: new Date().toISOString(),
            lastModifiedAt: new Date().toISOString(),
          });
          sse.sendDocument({
            type: "screen_inventory",
            content: r.content,
            version: 1,
          });
        },
      },
    ];

    const dag = new DependencyGraphExecutor({
      onProgress: (opId, status) => {
        sse.sendProgress({ operationId: opId, status });
      },
    });

    await dag.execute(nodes);

    await setPhase2Stage(
      storage,
      sessionId,
      stageAfterRunning("design_running"),
    );
    sse.sendStage({
      stageName: "design",
      status: "review",
      detail:
        "Review the Workflow Map and Screen Inventory, then click Approve to generate the wireframe.",
    });
    sse.sendComplete({ event: "design_stage_complete" });
  }

  // Stage 2: Wireframe — dummy data + shell + per-screen HTML + data.js.
  // Ops: 2.4a, 2.4b, 2.4c, 2.4d, 2.4e.
  private async runWireframeStage(
    sessionId: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage, executor, promptRegistry } = this.deps;
    const wm = this.wireframeManager;

    await setPhase2Stage(storage, sessionId, "wireframe_running");
    sse.sendStage({ stageName: "wireframe", status: "running" });

    const prior = await readDesignStageOutputs(storage, sessionId);
    const state: WireframeStageState = {
      workflowMapStructuredData: prior.workflowMapStructuredData,
      finalScreenInventoryYaml: prior.screenInventoryYaml,
      screenIds: prior.screenIds,
      dummyDataJson: "",
      screenHtmlMap: new Map(),
      smokeTestPassed: false,
    };

    const nodes: GraphNode[] = [
      {
        operationId: "op-2-4a",
        dependencies: [],
        execute: async () => {
          const r = await executeDummyDataGeneration(
            executor,
            promptRegistry,
            storage,
            sessionId,
            state.workflowMapStructuredData,
          );
          state.dummyDataJson = r.dummyDataJson;
        },
      },
      {
        operationId: "op-2-4b",
        dependencies: [],
        execute: async () => {
          const r = await executeWireframeShell(
            executor,
            promptRegistry,
            state.finalScreenInventoryYaml,
            sessionId,
          );
          await wm.writeFile(sessionId, "index.html", r.shellHtml);
        },
      },
      {
        operationId: "op-2-4c",
        dependencies: ["op-2-4a"],
        execute: async () => {
          const r = await executeScreenHtmlBatch(
            executor,
            promptRegistry,
            state.finalScreenInventoryYaml,
            state.dummyDataJson,
            state.workflowMapStructuredData,
            sessionId,
          );
          state.screenHtmlMap = r.screenHtmlMap;
          for (const [screenId, html] of r.screenHtmlMap) {
            await wm.writeFile(sessionId, `${screenId}.html`, html);
          }
        },
      },
      {
        operationId: "op-2-4d",
        dependencies: ["op-2-4c"],
        execute: async () => {
          const r = await executeWireframeSmokeTest(
            wm,
            sessionId,
            state.screenIds,
          );
          state.smokeTestPassed = r.passed;
          if (!r.passed) {
            console.warn("Wireframe smoke test issues:", r.issues);
          }
        },
      },
      {
        operationId: "op-2-4e",
        dependencies: ["op-2-4a"],
        execute: async () => {
          const dataJs = assembleDataFile(state.dummyDataJson);
          await wm.writeFile(sessionId, "data.js", dataJs);
        },
      },
    ];

    const dag = new DependencyGraphExecutor({
      onProgress: (opId, status) => {
        sse.sendProgress({ operationId: opId, status });
      },
    });

    await dag.execute(nodes);

    await setPhase2Stage(
      storage,
      sessionId,
      stageAfterRunning("wireframe_running"),
    );
    sse.sendStage({
      stageName: "wireframe",
      status: "review",
      detail:
        "Wireframe ready. Click the Wireframe tab to explore, then Approve to generate the test suite.",
    });
    sse.sendComplete({ event: "wireframe_stage_complete" });
  }

  // Stage 3: Test Suite — test cases + coverage + formatted doc.
  // Ops: 2.2a, 2.2b, 2.2c.
  private async runTestSuiteStage(
    sessionId: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage, executor, promptRegistry } = this.deps;

    await setPhase2Stage(storage, sessionId, "test_suite_running");
    sse.sendStage({ stageName: "test_suite", status: "running" });

    const prior = await readDesignStageOutputs(storage, sessionId);
    const state: TestSuiteStageState = {
      detailedWorkflows: prior.detailedWorkflows,
      workflowMapStructuredData: prior.workflowMapStructuredData,
      testCaseBlocks: [],
      coverageYaml: "",
      testSuiteStructuredData: "",
    };

    const nodes: GraphNode[] = [
      {
        operationId: "op-2-2a",
        dependencies: [],
        execute: async () => {
          const r = await executeTestCaseGenerationBatch(
            executor,
            promptRegistry,
            storage,
            sessionId,
            state.detailedWorkflows,
          );
          state.testCaseBlocks = r.testCaseBlocks;
        },
      },
      {
        operationId: "op-2-2b",
        dependencies: [],
        execute: async () => {
          const r = await executeEntityCoverageCheck(
            executor,
            promptRegistry,
            storage,
            sessionId,
            state.workflowMapStructuredData,
          );
          state.coverageYaml = r.coverageYaml;
        },
      },
      {
        operationId: "op-2-2c",
        dependencies: ["op-2-2a", "op-2-2b"],
        execute: async () => {
          const r = await executeTestSuiteFormatting(
            executor,
            promptRegistry,
            state.testCaseBlocks,
            state.coverageYaml,
            sessionId,
          );
          state.testSuiteStructuredData = r.structuredData;

          await storage.createDocument({
            id: uuidv4(),
            sessionId,
            phaseId: "phase-2",
            type: "test_suite",
            content: r.content,
            structuredData: r.structuredData,
            version: 1,
            status: "active",
            createdAt: new Date().toISOString(),
            lastModifiedAt: new Date().toISOString(),
          });
          sse.sendDocument({
            type: "test_suite",
            content: r.content,
            version: 1,
          });
        },
      },
    ];

    const dag = new DependencyGraphExecutor({
      onProgress: (opId, status) => {
        sse.sendProgress({ operationId: opId, status });
      },
    });

    await dag.execute(nodes);

    await setPhase2Stage(
      storage,
      sessionId,
      stageAfterRunning("test_suite_running"),
    );
    sse.sendStage({
      stageName: "test_suite",
      status: "review",
      detail:
        "Test suite generated. Review it alongside the wireframe, then click Approve to generate executable tests.",
    });
    sse.sendComplete({ event: "test_suite_stage_complete" });
  }

  // Stage 4: Automated Tests — harness + translation + bundle + dry run + repair.
  // Ops: 2.5a, 2.5b, 2.5c, 2.5d, 2.5e (conditional).
  private async runAutomatedTestsStage(
    sessionId: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage, executor, promptRegistry } = this.deps;
    const wm = this.wireframeManager;

    await setPhase2Stage(storage, sessionId, "automated_tests_running");
    sse.sendStage({ stageName: "automated_tests", status: "running" });

    const designOut = await readDesignStageOutputs(storage, sessionId);
    const testSuiteOut = await readTestSuiteStageOutputs(storage, sessionId);
    const state: AutomatedTestsStageState = {
      screenIds: designOut.screenIds,
      finalScreenInventoryYaml: designOut.screenInventoryYaml,
      testCaseBlocks: testSuiteOut.testCaseBlocks,
      translatedTests: [],
      dryRunHadFailures: false,
    };

    const nodes: GraphNode[] = [
      {
        operationId: "op-2-5a",
        dependencies: [],
        execute: async () => {
          const r = await executeTestHarnessGeneration(
            executor,
            promptRegistry,
            state.screenIds,
            sessionId,
          );
          await wm.writeFile(sessionId, "test-harness.html", r.harnessHtml);
        },
      },
      {
        operationId: "op-2-5b",
        dependencies: [],
        execute: async () => {
          const r = await executeTestTranslationBatch(
            executor,
            promptRegistry,
            wm,
            sessionId,
            state.testCaseBlocks,
            state.finalScreenInventoryYaml,
          );
          state.translatedTests = r.translatedTests;
        },
      },
      {
        operationId: "op-2-5c",
        dependencies: ["op-2-5b"],
        execute: async () => {
          const testsJs = assembleTestBundle(state.translatedTests);
          await wm.writeFile(sessionId, "tests.js", testsJs);
        },
      },
      {
        operationId: "op-2-5d",
        dependencies: ["op-2-5c"],
        execute: async () => {
          const r = await executeTestDryRun();
          state.dryRunHadFailures = r.results.some((x) => x.status === "fail");
        },
      },
      {
        operationId: "op-2-5e",
        dependencies: ["op-2-5d"],
        condition: async () => state.dryRunHadFailures,
        execute: async () => {
          // Real repair loop lives in Sprint 8; condition prevents it
          // from running when the dry run is clean.
        },
      },
    ];

    const dag = new DependencyGraphExecutor({
      onProgress: (opId, status) => {
        sse.sendProgress({ operationId: opId, status });
      },
    });

    await dag.execute(nodes);

    await setPhase2Stage(
      storage,
      sessionId,
      stageAfterRunning("automated_tests_running"),
    );
    sse.sendStage({
      stageName: "automated_tests",
      status: "complete",
      detail:
        "Automated tests generated. You can now click Done to run Phase 2 validation.",
    });
    sse.sendComplete({ event: "automated_tests_stage_complete" });
  }

  // ── Helpers ─────────────────────────────────────────────────

  // Transitions phase-2 state to active (creating it if missing) and
  // marks the session as being in phase-2.
  private async initializePhase2(
    sessionId: string,
    sse: SSEWriter,
  ): Promise<void> {
    const { storage } = this.deps;
    const existing = await storage.getPhaseState(sessionId, "phase-2");
    if (!existing) {
      await storage.upsertPhaseState({
        sessionId,
        phaseId: "phase-2",
        status: "not_started",
        enteredAt: null,
        completedAt: null,
        suspendedAt: null,
      });
    }

    await transitionPhase(storage, sessionId, "phase-2", "active");
    await storage.updateSession(sessionId, {
      currentPhaseId: "phase-2",
      phase2Stage: "not_started" as Phase2Stage,
    });

    sse.send({
      type: "phase",
      data: { phaseId: "phase-2", status: "active" },
    });
  }

  private formatPhase2ValidationMessage(result: {
    codeChecks: { passed: boolean; failures: string[] };
    aiValidation: {
      status: string;
      issues: string[];
      warnings: string[];
      suggestions: string[];
    } | null;
    overall: string;
  }): string {
    const lines: string[] = [`STATUS: ${result.overall}`];
    if (result.codeChecks.failures.length > 0) {
      lines.push("", "Code check failures:");
      for (const f of result.codeChecks.failures) lines.push(`- ${f}`);
    }
    if (result.aiValidation) {
      if (result.aiValidation.issues.length > 0) {
        lines.push("", "AI validation issues:");
        for (const issue of result.aiValidation.issues) lines.push(`- ${issue}`);
      }
      if (result.aiValidation.warnings.length > 0) {
        lines.push("", "Warnings:");
        for (const w of result.aiValidation.warnings) lines.push(`- ${w}`);
      }
      if (result.aiValidation.suggestions.length > 0) {
        lines.push("", "Suggestions:");
        for (const s of result.aiValidation.suggestions) lines.push(`- ${s}`);
      }
    }
    return lines.join("\n");
  }
}

// ── Stage output recovery (free functions) ────────────────────

async function readDesignStageOutputs(
  storage: IStorage,
  sessionId: string,
): Promise<{
  workflowMapStructuredData: string;
  detailedWorkflows: string[];
  screenInventoryYaml: string;
  screenIds: string[];
}> {
  const [workflowMap, screenInventory] = await Promise.all([
    storage.getActiveDocument(sessionId, "workflow_map"),
    storage.getActiveDocument(sessionId, "screen_inventory"),
  ]);

  if (!workflowMap) {
    throw new Error(
      "Workflow Map not found — cannot run this stage without Stage 1 output.",
    );
  }
  if (!screenInventory) {
    throw new Error(
      "Screen Inventory not found — cannot run this stage without Stage 1 output.",
    );
  }

  // structuredData for workflow_map is detailedWorkflows joined by "\n---\n"
  const detailedWorkflows = workflowMap.structuredData
    .split(/\n---\n/)
    .filter((s) => s.trim().length > 0);

  const screenInventoryYaml = screenInventory.structuredData;
  const screenIds = extractScreenIdsFromYaml(screenInventoryYaml);

  return {
    workflowMapStructuredData: workflowMap.structuredData,
    detailedWorkflows,
    screenInventoryYaml,
    screenIds,
  };
}

async function readTestSuiteStageOutputs(
  storage: IStorage,
  sessionId: string,
): Promise<{ testCaseBlocks: string[] }> {
  const testSuite = await storage.getActiveDocument(sessionId, "test_suite");
  if (!testSuite) {
    throw new Error(
      "Test Suite not found — cannot run this stage without Stage 3 output.",
    );
  }
  // structuredData for test_suite is testCaseBlocks joined by "\n---\n"
  const testCaseBlocks = testSuite.structuredData
    .split(/\n---\n/)
    .filter((s) => s.trim().length > 0);
  return { testCaseBlocks };
}

function extractScreenIdsFromYaml(yaml: string): string[] {
  try {
    const parsed = parseYamlLib(yaml) as Record<string, unknown>;
    const screens = (parsed.screens ?? []) as Record<string, unknown>[];
    return screens.map((s) => s.id as string).filter(Boolean);
  } catch {
    return [];
  }
}
