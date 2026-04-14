import { describe, expect, it, vi } from "vitest";

import type {
  OperationDefinition,
  OperationResult,
  ParsedOutput,
} from "@core/types";

import { OperationExecutor } from "../executor";
import { executeTwoAIPattern, type ContextExtractor } from "../two-ai-pattern";

// Helper: synthesize an OperationDefinition stub. The Two-AI orchestrator
// only cares about operationId and outputParser identity; we never actually
// hit pi-ai because we stub executor.execute.
function defStub(operationId: string): OperationDefinition {
  return {
    operationId: operationId as OperationDefinition["operationId"],
    systemPrompt: "stub",
    messages: [{ role: "user", content: "stub" }],
    expectedOutputFormat: "structured",
    outputParser: () => ({
      success: true,
      data: {},
      rawText: "",
    }),
    maxRetries: 0,
    retryPrompt: null,
    timeoutMs: 1000,
  };
}

function successResult(
  operationId: string,
  parsedData: unknown,
  rawText = "",
): OperationResult {
  const output: ParsedOutput = {
    success: true,
    data: parsedData,
    rawText,
  };
  return {
    operationId: operationId as OperationResult["operationId"],
    status: "success",
    output,
    error: null,
    tokenUsage: { input: 10, output: 20 },
    cost: 0,
    durationMs: 100,
  };
}

function failedResult(operationId: string, error: string): OperationResult {
  return {
    operationId: operationId as OperationResult["operationId"],
    status: "failed",
    output: null,
    error,
    tokenUsage: { input: 10, output: 0 },
    cost: 0,
    durationMs: 100,
  };
}

describe("executeTwoAIPattern", () => {
  it("runs Call A → extract → Call B and returns combined result", async () => {
    const executor = new OperationExecutor();

    // Mock executor.execute to return Call A then Call B in order.
    const executeSpy = vi
      .spyOn(executor, "execute")
      .mockResolvedValueOnce(
        successResult("op-1-1", {
          visibleResponse: "Got it, recipe app for home cooks.",
          generationContext: { goal: "Recipe app", audience: "home cooks" },
          isClarifyingQuestion: false,
        }),
      )
      .mockResolvedValueOnce(
        successResult(
          "op-1-1",
          {
            sections: { Goals: "Build a recipe app." },
            fullMarkdown: "## Goals\n\nBuild a recipe app.",
          },
          "## Goals\n\nBuild a recipe app.",
        ),
      );

    const callADef = defStub("op-1-1");
    const callBFactory = vi
      .fn()
      .mockReturnValue(defStub("op-1-1"));

    const extractor: ContextExtractor = (output) => {
      const data = output.data as {
        visibleResponse: string;
        generationContext: unknown;
        isClarifyingQuestion: boolean;
      };
      return {
        visibleResponse: data.visibleResponse,
        contextData: data.generationContext,
        isClarifyingQuestion: data.isClarifyingQuestion,
      };
    };

    const result = await executeTwoAIPattern(
      executor,
      callADef,
      callBFactory,
      extractor,
    );

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(callBFactory).toHaveBeenCalledOnce();
    expect(callBFactory).toHaveBeenCalledWith({
      goal: "Recipe app",
      audience: "home cooks",
    });
    expect(result.isClarifyingQuestion).toBe(false);
    expect(result.visibleResponse).toContain("recipe app");
    expect(result.generatedDocument).toContain("## Goals");
    expect(result.structuredData).toEqual({
      goal: "Recipe app",
      audience: "home cooks",
    });
    expect(result.callBResult).not.toBeNull();
  });

  it("short-circuits when Call A returns a clarifying question", async () => {
    const executor = new OperationExecutor();
    const executeSpy = vi.spyOn(executor, "execute").mockResolvedValueOnce(
      successResult("op-1-1", {
        visibleResponse: "What kind of recipes?",
        generationContext: null,
        isClarifyingQuestion: true,
      }),
    );

    const callADef = defStub("op-1-1");
    const callBFactory = vi.fn().mockReturnValue(defStub("op-1-1"));
    const extractor: ContextExtractor = (output) => {
      const data = output.data as {
        visibleResponse: string;
        generationContext: unknown;
        isClarifyingQuestion: boolean;
      };
      return {
        visibleResponse: data.visibleResponse,
        contextData: data.generationContext,
        isClarifyingQuestion: data.isClarifyingQuestion,
      };
    };

    const result = await executeTwoAIPattern(
      executor,
      callADef,
      callBFactory,
      extractor,
    );

    expect(executeSpy).toHaveBeenCalledTimes(1); // Call B never ran
    expect(callBFactory).not.toHaveBeenCalled();
    expect(result.isClarifyingQuestion).toBe(true);
    expect(result.visibleResponse).toBe("What kind of recipes?");
    expect(result.generatedDocument).toBeNull();
    expect(result.callBResult).toBeNull();
  });

  it("throws when Call A fails", async () => {
    const executor = new OperationExecutor();
    vi.spyOn(executor, "execute").mockResolvedValueOnce(
      failedResult("op-1-1", "transport error"),
    );

    await expect(
      executeTwoAIPattern(
        executor,
        defStub("op-1-1"),
        () => defStub("op-1-1"),
        () => ({
          contextData: {},
          visibleResponse: "",
          isClarifyingQuestion: false,
        }),
      ),
    ).rejects.toThrow(/Call A.*transport error/);
  });

  it("throws when Call B fails", async () => {
    const executor = new OperationExecutor();
    vi.spyOn(executor, "execute")
      .mockResolvedValueOnce(
        successResult("op-1-1", {
          visibleResponse: "OK.",
          generationContext: { goal: "x" },
          isClarifyingQuestion: false,
        }),
      )
      .mockResolvedValueOnce(failedResult("op-1-1", "parser exhausted"));

    await expect(
      executeTwoAIPattern(
        executor,
        defStub("op-1-1"),
        () => defStub("op-1-1"),
        (out) => {
          const d = out.data as {
            visibleResponse: string;
            generationContext: unknown;
            isClarifyingQuestion: boolean;
          };
          return {
            contextData: d.generationContext,
            visibleResponse: d.visibleResponse,
            isClarifyingQuestion: d.isClarifyingQuestion,
          };
        },
      ),
    ).rejects.toThrow(/Call B.*parser exhausted/);
  });
});
