import { getBootstrap } from "@core/bootstrap";

// GET /api/sessions
//
// Returns a list of all sessions on disk, ordered by most recent first.
// This is the sidebar data source in the UI (Sprint 5.5).
//
// Response: { sessions: Session[] }

export async function GET(): Promise<Response> {
  const { storage } = getBootstrap();
  const sessions = await storage.listSessions();
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return Response.json({ sessions });
}
