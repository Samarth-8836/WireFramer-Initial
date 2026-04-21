"use client";

import { useSessionStore } from "@stores/session-store";
import { useChatStore } from "@stores/chat-store";
import { useDocumentStore } from "@stores/document-store";

export function SessionSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const clearActive = useSessionStore((s) => s.clearActive);

  const handleNewChat = () => {
    clearActive();
    useChatStore.getState().clear();
    useDocumentStore.getState().clear();
  };

  const handleSelectSession = async (id: string) => {
    if (id === activeSessionId) return;
    useChatStore.getState().clear();
    useDocumentStore.getState().clear();

    const data = await setActiveSession(id);
    if (data) {
      // Hydrate chat and documents from the snapshot.
      const phase1Messages = data.messages?.["phase-1"] ?? [];
      const phase2Messages = data.messages?.["phase-2"] ?? [];
      const currentPhase = data.session?.currentPhaseId ?? "phase-1";
      const messages =
        currentPhase === "phase-1" ? phase1Messages : phase2Messages;
      useChatStore.getState().loadMessages(messages);

      if (data.documents?.length) {
        useDocumentStore.getState().loadDocuments(data.documents);
      }
    }
  };

  return (
    <aside className="flex w-60 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          UX Builder
        </span>
        <button
          onClick={handleNewChat}
          className="rounded-md bg-blue-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600"
        >
          + New
        </button>
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-zinc-400">
            No sessions yet.
            <br />
            Start a new chat to begin.
          </p>
        )}
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => void handleSelectSession(session.id)}
            className={`w-full px-4 py-2.5 text-left transition-colors ${
              session.id === activeSessionId
                ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            <div className="truncate text-sm font-medium">
              {session.title || "Untitled"}
            </div>
            <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
              {formatRelativeTime(session.updatedAt)}
            </div>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
