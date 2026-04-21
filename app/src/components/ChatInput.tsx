"use client";

import { useCallback, useRef, useState } from "react";

import { useChatStore } from "@stores/chat-store";
import { useSessionStore } from "@stores/session-store";
import { useSSE } from "@lib/use-sse";

export function ChatInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBlocked = useChatStore((s) => s.isBlocked);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const phaseStates = useSessionStore((s) => s.phaseStates);

  const { sendMessage, completePhase } = useSSE();

  const phase1Status = phaseStates["phase-1"]?.status ?? "active";
  const canComplete =
    activeSessionId &&
    !isBlocked &&
    (phase1Status === "active" || phase1Status === "completing");

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isBlocked) return;

    sendMessage({
      sessionId: activeSessionId,
      message: trimmed,
    });

    setText("");
    textareaRef.current?.focus();
  }, [text, isBlocked, activeSessionId, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleDone = () => {
    if (!activeSessionId || isBlocked) return;
    completePhase(activeSessionId);
  };

  return (
    <div className="border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isBlocked ? "Waiting for response..." : "Describe your product idea..."
          }
          disabled={isBlocked}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
          style={{ maxHeight: 120 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || isBlocked}
          className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {/* Done button for phase completion */}
      {canComplete && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={handleDone}
            disabled={isBlocked}
            className="rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition-colors hover:bg-green-100 disabled:opacity-40 dark:border-green-800 dark:bg-green-950 dark:text-green-300 dark:hover:bg-green-900"
          >
            Done — Validate &amp; Complete Phase 1
          </button>
        </div>
      )}
    </div>
  );
}
