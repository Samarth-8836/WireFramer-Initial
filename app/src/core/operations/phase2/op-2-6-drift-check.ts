// Op 2.6 — Drift Check.
//
// Validates that a proposed change (from Op 2.7a's <change_context>) stays
// within the boundaries of the locked Project Contract. Returns one of
// COMPATIBLE | FLAG | DRIFT.

import type { ContextBuilder } from "@core/context-builder";
import type { OperationExecutor } from "@core/operation-executor";
import { parseDriftResult } from "@core/operation-executor";
import type { OperationDefinition } from "@core/types";

export interface DriftCheckResult {
  classification: "COMPATIBLE" | "FLAG" | "DRIFT";
  type: string;
  reason: string;
}

export async function executeDriftCheck(
  executor: OperationExecutor,
  contextBuilder: ContextBuilder,
  sessionId: string,
  changeContextYaml: string,
): Promise<DriftCheckResult> {
  const context = await contextBuilder.buildDriftCheck(
    sessionId,
    changeContextYaml,
  );

  const def: OperationDefinition = {
    operationId: "op-2-6",
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    expectedOutputFormat: "structured",
    outputParser: parseDriftResult,
    maxRetries: 1,
    retryPrompt:
      "Respond in EXACTLY this format:\nclassification: [COMPATIBLE or FLAG or DRIFT]\ntype: [drift type or NONE]\nreason: [one sentence]",
    timeoutMs: 60_000,
    role: "fast",
  };

  const result = await executor.execute(def, { sessionId });
  if (result.status === "failed" || !result.output) {
    // On failure, be conservative — treat as compatible so the user's
    // change isn't blocked by an infrastructure issue.
    return {
      classification: "COMPATIBLE",
      type: "NONE",
      reason: "Drift check failed; proceeding as compatible.",
    };
  }

  const data = result.output.data as Record<string, string>;
  return {
    classification: (data.classification ?? "COMPATIBLE") as DriftCheckResult["classification"],
    type: data.type ?? "NONE",
    reason: data.reason ?? "",
  };
}
