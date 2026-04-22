import type { NextRequest } from "next/server";

import { getSessionManager } from "@core/bootstrap";
import { createSSEResponse, SSEWriter } from "@core/operation-executor";

// POST /api/chat
//
// Body: { sessionId?: string, message: string, screenRef?: string | null }
//
// Behavior:
//   - If sessionId is missing, create a brand-new session via
//     SessionManager.createSession (runs Op 1.0 title + Op 1.1 goal expansion).
//   - If sessionId is present, route through SessionManager.handleMessage
//     which picks Op 1.1 / 1.2 / 2.7a based on the current phase + state.
//
// Returns an SSE stream. Events are standardized via SSEWriter:
//   meta        — session + phase config before streaming begins
//   chunk       — assistant text deltas (word-by-word rendering in the UI)
//   document    — Project Contract updates
//   progress    — operation-level status
//   error       — fatal or non-fatal errors
//   complete    — stream terminated normally
//
// The caller is expected to be a streaming-aware consumer (EventSource,
// fetch + ReadableStream). A curl --no-buffer user can read the raw
// events straight from the wire.

interface ChatRequestBody {
  sessionId?: string;
  message?: string;
  screenRef?: string | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const message = body.message?.trim();
  if (!message) {
    return jsonError("Missing required field: message", 400);
  }

  const sessionManager = getSessionManager();
  const writer = new SSEWriter();
  const response = createSSEResponse(writer);

  // Kick off the operation without awaiting so the stream can start flowing
  // immediately. The writer's internal queue handles backpressure.
  void (async () => {
    try {
      if (!body.sessionId) {
        // SessionManager.createSession emits `session_info` itself, before
        // the stream is closed by sendComplete inside handleFirstMessage.
        await sessionManager.createSession(message, writer);
      } else {
        writer.sendMeta({ event: "message_ack", sessionId: body.sessionId });
        await sessionManager.handleMessage(
          body.sessionId,
          message,
          body.screenRef ?? null,
          writer,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.sendError(`Chat route failure: ${msg}`, true);
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
