import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";

// GET /api/sessions/[id]
//
// Returns a full session snapshot — session record, phase states, active
// documents, all chat messages for both phases. Used when the UI hydrates
// a session tab.
//
// Next.js 16: `params` is now a Promise<{ id: string }> and must be
// awaited before use.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { storage } = getBootstrap();

  const session = await storage.getSession(id);
  if (!session) {
    return Response.json(
      { error: `Session ${id} not found` },
      { status: 404 },
    );
  }

  const [phase1State, phase2State, documents, phase1Messages, phase2Messages] =
    await Promise.all([
      storage.getPhaseState(id, "phase-1"),
      storage.getPhaseState(id, "phase-2"),
      storage.getDocumentsBySession(id),
      storage.getMessagesByPhase(id, "phase-1"),
      storage.getMessagesByPhase(id, "phase-2"),
    ]);

  return Response.json({
    session,
    phaseStates: {
      "phase-1": phase1State,
      "phase-2": phase2State,
    },
    documents: documents.filter((d) => d.status === "active"),
    messages: {
      "phase-1": phase1Messages,
      "phase-2": phase2Messages,
    },
  });
}
