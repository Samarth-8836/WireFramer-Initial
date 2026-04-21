import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { createSSEResponse, SSEWriter } from "@core/operation-executor";
import { executeRollback } from "@core/session-manager/rollback";

// POST /api/rollback
//
// Body: { sessionId: string }
//
// Suspends Phase 2 and reactivates Phase 1 so the user can edit the
// Project Contract. Returns SSE stream with rollback progress.

interface RollbackBody {
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: RollbackBody;
  try {
    body = (await req.json()) as RollbackBody;
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

  void (async () => {
    try {
      await executeRollback(storage, body.sessionId!, writer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.sendError(`Rollback failed: ${msg}`, true);
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
