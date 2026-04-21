import type { NextRequest } from "next/server";

import { WireframeManager } from "@core/wireframe/wireframe-manager";

// GET /api/wireframe/:sessionId/:filename
//
// Serves wireframe files (index.html, data.js, screen HTML, test harness,
// tests.js) from the session's wireframe directory. Used by the iframe-based
// WireframeViewer and by Playwright during test dry runs.
//
// Next.js 16: params is Promise<{ sessionId, filename }>.

const DATA_DIR = process.env.DATA_DIR ?? "./data";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; filename: string }> },
): Promise<Response> {
  const { sessionId, filename } = await params;
  const manager = new WireframeManager(DATA_DIR);

  try {
    const content = await manager.readFile(sessionId, filename);
    const contentType = manager.getContentType(filename);

    return new Response(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
