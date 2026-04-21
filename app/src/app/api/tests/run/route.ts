import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { WireframeManager } from "@core/wireframe/wireframe-manager";
import { executeTestRun } from "@core/operations/phase2/op-2-8-test-execution";

// POST /api/tests/run
//
// Body: { sessionId: string }
//
// Runs the test suite against the wireframe prototype and returns results.

export async function POST(req: NextRequest): Promise<Response> {
  let body: { sessionId?: string };
  try {
    body = (await req.json()) as { sessionId?: string };
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId) {
    return jsonError("Missing required field: sessionId", 400);
  }

  const { storage } = getBootstrap();
  const wireframeManager = new WireframeManager(
    process.env.DATA_DIR ?? "./data",
  );

  try {
    const result = await executeTestRun(wireframeManager, body.sessionId);

    // Persist the results.
    await storage.saveTestRunResult(result);

    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(`Test execution failed: ${msg}`, 500);
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
