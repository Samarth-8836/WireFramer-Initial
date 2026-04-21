"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useSessionStore } from "@stores/session-store";

export function WireframeViewer() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentScreenId, setCurrentScreenId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

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

      {/* Iframe */}
      <div className="relative flex-1">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
            <p className="text-sm text-zinc-400">Loading wireframe...</p>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={wireframeUrl}
          onLoad={handleIframeLoad}
          sandbox="allow-same-origin allow-scripts"
          className="h-full w-full border-0"
          title="Wireframe Preview"
        />
      </div>
    </div>
  );
}
