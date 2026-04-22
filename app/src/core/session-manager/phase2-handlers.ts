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

import type { AutoGenRunners, AutoGenConditions } from "./auto-generation-graph";
import { buildAutoGenerationGraph } from "./auto-generation-graph";
import { CascadeExecutor } from "./cascade-executor";
import { routeCascade } from "./cascade-router";
import { DependencyGraphExecutor } from "./dependency-graph";
import { transitionPhase } from "./phase-state-machine";
import type { Phase2Handlers } from "./session-manager";

interface Phase2Deps {
  storage: IStorage;
  executor: OperationExecutor;
  promptRegistry: IPromptRegistry;
  contextBuilder: ContextBuilder;
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
    // Ensure a phase-2 state record exists before transitioning. For a
    // fresh session that just finished Phase 1, there's no phase-2 row
    // yet — transitionPhase would throw "no phase state" without this.
    const existing = await this.deps.storage.getPhaseState(
      sessionId,
      "phase-2",
    );
    if (!existing) {
      await this.deps.storage.upsertPhaseState({
        sessionId,
        phaseId: "phase-2",
        status: "not_started",
        enteredAt: null,
        completedAt: null,
        suspendedAt: null,
      });
    }

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
        // For now, proceed anyway. The UI will show a warning banner
        // and let the user choose. A full implementation would wait
        // for user confirmation before continuing.
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

    // 5. Execute cascade.
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

      // Persist validation result as a system message.
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
          data: { from: "phase-2", to: "phase-2", status: "complete" },
        });
      } else {
        sse.send({
          type: "phase",
          data: { from: "phase-2", to: "phase-2", status: "active" },
        });
      }

      // Surface the detailed results.
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

  private formatPhase2ValidationMessage(result: {
    codeChecks: { passed: boolean; failures: string[] };
    aiValidation: { status: string; issues: string[]; warnings: string[]; suggestions: string[] } | null;
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
