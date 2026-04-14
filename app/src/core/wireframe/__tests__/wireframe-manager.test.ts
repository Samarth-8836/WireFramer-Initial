import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WireframeManager } from "../wireframe-manager";

describe("WireframeManager", () => {
  let dataDir: string;
  let mgr: WireframeManager;
  const sessionId = "wf-session";

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uxb-wireframe-"));
    mgr = new WireframeManager(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("write → read round-trips content", async () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    const filePath = await mgr.writeFile(sessionId, "index.html", html);
    expect(filePath).toContain("index.html");
    const got = await mgr.readFile(sessionId, "index.html");
    expect(got).toBe(html);
  });

  it("listFiles returns written filenames", async () => {
    await mgr.writeFile(sessionId, "index.html", "x");
    await mgr.writeFile(sessionId, "data.js", "y");
    const list = await mgr.listFiles(sessionId);
    expect(list.sort()).toEqual(["data.js", "index.html"]);
  });

  it("listFiles returns [] for unknown session", async () => {
    const list = await mgr.listFiles("does-not-exist");
    expect(list).toEqual([]);
  });

  it("deleteFile removes the file", async () => {
    await mgr.writeFile(sessionId, "index.html", "x");
    await mgr.deleteFile(sessionId, "index.html");
    const list = await mgr.listFiles(sessionId);
    expect(list).toEqual([]);
  });

  it("deleteFile is idempotent for missing files", async () => {
    await expect(
      mgr.deleteFile(sessionId, "never-existed.html"),
    ).resolves.not.toThrow();
  });

  it("getContentType maps common extensions", () => {
    expect(mgr.getContentType("index.html")).toBe("text/html");
    expect(mgr.getContentType("foo.HTM")).toBe("text/html");
    expect(mgr.getContentType("data.js")).toBe("application/javascript");
    expect(mgr.getContentType("style.css")).toBe("text/css");
    expect(mgr.getContentType("config.json")).toBe("application/json");
    expect(mgr.getContentType("logo.svg")).toBe("image/svg+xml");
    expect(mgr.getContentType("blob.bin")).toBe("application/octet-stream");
  });

  it("write is atomic — no .tmp file lingers on success", async () => {
    await mgr.writeFile(sessionId, "index.html", "x");
    const list = await mgr.listFiles(sessionId);
    expect(list.find((f) => f.endsWith(".tmp"))).toBeUndefined();
  });
});
