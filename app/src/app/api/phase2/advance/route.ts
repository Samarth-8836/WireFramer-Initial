import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { createSSEResponse, SSEWriter } from "@core/operation-executor";

// POST /api/phase2/advance
//
// Body: { sessionId: string }
//
// The user clicked "Approve" on the current stage's review. Dispatches
// to the next stage runner (wireframe → test_suite → automated_tests).
// The server validates that the session is currently in a `*_review`
// stage before running anything.
//
// Response: SSE stream with `stage`, `progress`, `document`, and
// `complete` events for the next stage.

interface AdvanceBody {
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: AdvanceBody;
  try {
    body = (await req.json()) as AdvanceBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId) {
    return jsonError("Missing required field: sessionId", 400);
  }

  const { storage } = getBootstrap();
  const session = await storage.getSession(body.sessionId);
  if (!session) {
    return jsonError(`Session ${body.sessionId} not found`, 404);
  }

  const writer = new SSEWriter();
  const response = createSSEResponse(writer);

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
        event: "phase2_advance",
        sessionId: body.sessionId,
      });
      await phase2Handlers.advanceStage(body.sessionId!, writer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.sendError(`Stage advance failed: ${msg}`, true);
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
