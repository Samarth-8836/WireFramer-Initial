import type { ContextBuilder } from "@core/context-builder";
import type { OperationExecutor } from "@core/operation-executor";
import {
  parseValidationResult,
  type ValidationResultData,
} from "@core/operation-executor";

// Op 1.3 — Phase 1 Validation.
//
// Single-call operation (no Two-AI pattern) that asks the validator
// model to score the current Project Contract against the structural +
// consistency criteria in spec §17.4. Returns PASS/FAIL plus a list of
// issues (on FAIL) and optional suggestions.
//
// Only runs when the user clicks "Done" in Phase 1. A FAIL result is not
// an error — it's the expected outcome for an incomplete contract, and
// the Session Manager surfaces the issues as a system_notification chat
// message so the user can fix and retry.

export async function validatePhase1(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  sessionId: string,
): Promise<ValidationResultData> {
  const context = await contextBuilder.buildPhase1Validation(sessionId);

  const result = await executor.execute(
    {
      operationId: "op-1-3",
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      expectedOutputFormat: "structured",
      outputParser: parseValidationResult,
      maxRetries: 1,
      retryPrompt:
        "Respond in the exact format: 'STATUS: PASS' or 'STATUS: FAIL' on the first line, followed by 'ISSUES:' section and 'SUGGESTIONS:' section with bullet lists.",
      timeoutMs: 60_000,
      role: "reasoning",
    },
    { sessionId },
  );

  if (result.status === "failed" || !result.output) {
    throw new Error(
      `Phase 1 validation call failed: ${result.error ?? "no output"}`,
    );
  }

  return result.output.data;
}
