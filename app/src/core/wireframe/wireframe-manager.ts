import { promises as fs } from "node:fs";
import path from "node:path";

// Manages the per-session wireframe directory that holds the generated HTML,
// JS, and CSS files. Read/write/list/delete only — no schema, no versioning.
// Versioning lives in the Artifact record; file content is overwritten in place
// when an artifact is regenerated.

export class WireframeManager {
  constructor(private readonly dataDir: string) {}

  getWireframeDir(sessionId: string): string {
    return path.join(this.dataDir, "sessions", sessionId, "wireframe");
  }

  async writeFile(
    sessionId: string,
    filename: string,
    content: string,
  ): Promise<string> {
    const dir = this.getWireframeDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
    return filePath;
  }

  async readFile(sessionId: string, filename: string): Promise<string> {
    const filePath = path.join(this.getWireframeDir(sessionId), filename);
    return fs.readFile(filePath, "utf-8");
  }

  async listFiles(sessionId: string): Promise<string[]> {
    const dir = this.getWireframeDir(sessionId);
    try {
      return await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async deleteFile(sessionId: string, filename: string): Promise<void> {
    const filePath = path.join(this.getWireframeDir(sessionId), filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  getContentType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
    if (lower.endsWith(".js") || lower.endsWith(".mjs"))
      return "application/javascript";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    return "application/octet-stream";
  }
}
