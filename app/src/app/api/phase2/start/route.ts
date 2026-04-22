import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { createSSEResponse, SSEWriter } from "@core/operation-executor";

// POST /api/phase2/start
//
// Body: { sessionId: string }
//
// Kicks off the Phase 2 auto-generation chain after Phase 1 completes.
// Returns an SSE stream with progress events for each of the 20 operations,
// document events for workflow_map / test_suite / screen_inventory, and
// a complete event when the chain finishes.

interface StartBody {
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId) {
    return jsonError("Missing required field: sessionId", 400);
  }

  const { storage } = getBootstrap();

  // Verify the session exists and Phase 1 is complete.
  const session = await storage.getSession(body.sessionId);
  if (!session) {
    return jsonError(`Session ${body.sessionId} not found`, 404);
  }

  const phase1State = await storage.getPhaseState(body.sessionId, "phase-1");
  if (!phase1State || phase1State.status !== "complete") {
    return jsonError(
      "Phase 1 must be complete before starting Phase 2",
      400,
    );
  }

  const writer = new SSEWriter();
  const response = createSSEResponse(writer);

  // runAutoGeneration is part of the Phase2Handlers interface; reach it
  // via the session manager's injected handlers.
  const phase2Handlers = (
    getBootstrap().sessionManager as unknown as {
      handlers: {
        phase2: import("@core/session-manager").Phase2Handlers;
      };
    }
  ).handlers.phase2;

  void (async () => {
    try {
      writer.sendMeta({
        event: "phase2_start",
        sessionId: body.sessionId,
      });
      await phase2Handlers.runAutoGeneration(body.sessionId!, writer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.sendError(`Phase 2 auto-generation failed: ${msg}`, true);
      writer.close();
    }
  })();

  return response;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
