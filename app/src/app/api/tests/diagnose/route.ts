import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import {
  executeDiagnosis,
  type DiagnosisInput,
} from "@core/operations/phase2/op-2-9-diagnosis";

// POST /api/tests/diagnose
//
// Body: { sessionId, testResult, testDefinitionYaml, workflowYaml }
//
// Diagnoses a test failure and returns the root cause + proposed fix.

interface DiagnoseBody {
  sessionId?: string;
  testResult?: DiagnosisInput["testResult"];
  testDefinitionYaml?: string;
  workflowYaml?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: DiagnoseBody;
  try {
    body = (await req.json()) as DiagnoseBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId || !body.testResult) {
    return jsonError("Missing required fields: sessionId, testResult", 400);
  }

  const { executor, promptRegistry } = getBootstrap();
  const wireframeManager = new WireframeManager(
    process.env.DATA_DIR ?? "./data",
  );

  try {
    const result = await executeDiagnosis(
      executor,
      promptRegistry,
      wireframeManager,
      body.sessionId,
      {
        testResult: body.testResult,
        testDefinitionYaml: body.testDefinitionYaml ?? "",
        workflowYaml: body.workflowYaml ?? "",
      },
    );

    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(`Diagnosis failed: ${msg}`, 500);
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
