"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useSessionStore } from "@stores/session-store";

type LoadState = "loading" | "ready" | "missing";

export function WireframeViewer() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentScreenId, setCurrentScreenId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // Listen for postMessage from the wireframe shell.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "screenChanged") {
        setCurrentScreenId(event.data.screenId);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // HEAD probe — check whether the wireframe file exists before we try to
  // render it in an iframe. Avoids showing a raw 404 inside the sandbox
  // when Phase 2 auto-gen is still running or has failed.
  useEffect(() => {
    if (!activeSessionId) return;
    setLoadState("loading");
    let cancelled = false;

    void fetch(`/api/wireframe/${activeSessionId}/index.html`, {
      method: "HEAD",
    })
      .then((res) => {
        if (cancelled) return;
        setLoadState(res.ok ? "ready" : "missing");
      })
      .catch(() => {
        if (!cancelled) setLoadState("missing");
      });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const handleIframeLoad = useCallback(() => {
    // onLoad still fires for a 404 response body — rely on the HEAD
    // probe above as the source of truth for readiness.
    if (loadState === "ready") {
      setLoadState("ready");
    }
  }, [loadState]);

  if (!activeSessionId) return null;

  const wireframeUrl = `/api/wireframe/${activeSessionId}/index.html`;

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-700 dark:bg-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Wireframe
          </span>
          {currentScreenId && (
            <span className="rounded bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              {currentScreenId}
            </span>
          )}
        </div>
      </div>

      {/* Body: loading / missing / iframe */}
      <div className="relative flex-1">
        {loadState === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
            <p className="text-sm text-zinc-400">Loading wireframe…</p>
          </div>
        )}

        {loadState === "missing" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
              Wireframe not ready yet
            </p>
            <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
              Phase 2 auto-generation is still running, or one of the
              earlier steps (workflow discovery, screen extraction)
              failed to produce wireframe files. Check the chat for
              progress or error messages.
            </p>
          </div>
        )}

        {loadState === "ready" && (
          <iframe
            ref={iframeRef}
            src={wireframeUrl}
            onLoad={handleIframeLoad}
            sandbox="allow-same-origin allow-scripts"
            className="h-full w-full border-0"
            title="Wireframe Preview"
          />
        )}
      </div>
    </div>
  );
}
