"use client";

import { useEffect } from "react";

import { useSessionStore } from "@stores/session-store";

import { ChatPanel } from "./ChatPanel";
import { DocumentPanel } from "./DocumentPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { PhaseIndicator } from "./PhaseIndicator";
import { SessionSidebar } from "./SessionSidebar";

export function AppShell() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const loadSessions = useSessionStore((s) => s.loadSessions);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        {/* Sidebar */}
        <SessionSidebar />

        {/* Main content area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Phase indicator */}
          {activeSessionId && <PhaseIndicator />}

          {/* Chat + Document split */}
          <div className="flex flex-1 overflow-hidden">
            <ChatPanel />
            <DocumentPanel />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
