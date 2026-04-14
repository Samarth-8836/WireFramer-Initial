import type { NextRequest } from "next/server";

import { getSessionManager } from "@core/bootstrap";
import { createSSEResponse, SSEWriter } from "@core/operation-executor";

// POST /api/phase/complete
//
// Body: { sessionId: string }
//
// Triggers the current phase's completion handler. For Phase 1 this runs
// Op 1.3 validation and, on PASS, transitions the session to
// phase-1 "complete". On FAIL, emits a validation_result SSE event with
// the issues list and keeps the phase active so the user can fix and
// retry.
//
// Returns an SSE stream with the same vocabulary as /api/chat.

interface PhaseCompleteBody {
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: PhaseCompleteBody;
  try {
    body = (await req.json()) as PhaseCompleteBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId) {
    return jsonError("Missing required field: sessionId", 400);
  }

  const sessionManager = getSessionManager();
  const writer = new SSEWriter();
  const response = createSSEResponse(writer);

  void (async () => {
    try {
      writer.sendMeta({ event: "phase_complete_start", sessionId: body.sessionId });
      await sessionManager.completePhase(body.sessionId!, writer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.sendError(`Phase completion failed: ${msg}`, true);
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
