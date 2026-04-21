import path from "node:path";

import type { NextRequest } from "next/server";

import { getBootstrap } from "@core/bootstrap";
import { WireframeManager } from "@core/wireframe/wireframe-manager";

// POST /api/export
//
// Exports all session artifacts as a JSON bundle. The client can then
// render a download prompt. Includes: session metadata, all documents,
// wireframe file list, and optionally wireframe HTML contents.
//
// Body: { sessionId: string, includeWireframeContent?: boolean }
//
// Response: JSON with all artifacts.

interface ExportBody {
  sessionId?: string;
  includeWireframeContent?: boolean;
}

interface ExportedDocument {
  type: string;
  content: string;
  version: number;
}

interface ExportedWireframeFile {
  filename: string;
  content?: string;
}

interface ExportBundle {
  exportedAt: string;
  session: {
    id: string;
    title: string;
    currentPhaseId: string;
    status: string;
    createdAt: string;
  };
  documents: ExportedDocument[];
  wireframeFiles: ExportedWireframeFile[];
  testResults: unknown | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ExportBody;
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.sessionId) {
    return jsonError("Missing required field: sessionId", 400);
  }

  const { storage } = getBootstrap();
  const dataDir =
    process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
  const wireframeManager = new WireframeManager(dataDir);

  const session = await storage.getSession(body.sessionId);
  if (!session) {
    return jsonError(`Session ${body.sessionId} not found`, 404);
  }

  // Gather documents.
  const docs = await storage.getDocumentsBySession(body.sessionId);
  const activeDocs = docs.filter((d) => d.status === "active");
  const exportedDocs: ExportedDocument[] = activeDocs.map((d) => ({
    type: d.type,
    content: d.content,
    version: d.version,
  }));

  // Gather wireframe files.
  const wireframeFileNames = await wireframeManager.listFiles(body.sessionId);
  const exportedFiles: ExportedWireframeFile[] = [];

  for (const filename of wireframeFileNames) {
    const entry: ExportedWireframeFile = { filename };
    if (body.includeWireframeContent) {
      try {
        entry.content = await wireframeManager.readFile(
          body.sessionId,
          filename,
        );
      } catch {
        entry.content = "(read error)";
      }
    }
    exportedFiles.push(entry);
  }

  // Latest test results.
  const testResults = await storage.getLatestTestRunResult(body.sessionId);

  const bundle: ExportBundle = {
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      currentPhaseId: session.currentPhaseId,
      status: session.status,
      createdAt: session.createdAt,
    },
    documents: exportedDocs,
    wireframeFiles: exportedFiles,
    testResults,
  };

  return new Response(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${session.title.replace(/[^a-zA-Z0-9]/g, "_")}_export.json"`,
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
