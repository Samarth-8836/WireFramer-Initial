"use client";

import { useEffect, useRef } from "react";

import { useChatStore } from "@stores/chat-store";
import { useSessionStore } from "@stores/session-store";

import { ChatInput } from "./ChatInput";
import { DriftWarningBanner } from "./DriftWarning";

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const driftWarning = useChatStore((s) => s.driftWarning);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages / streaming chunks.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingText]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden border-r border-zinc-200 dark:border-zinc-800">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!activeSessionId && messages.length === 0 && (
          <EmptyState />
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming assistant response */}
        {isStreaming && streamingText && (
          <div className="mb-4 flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-4 py-3 text-sm text-zinc-800 shadow-sm ring-1 ring-zinc-100 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700">
              <div className="whitespace-pre-wrap">{streamingText}</div>
              <span className="inline-block h-4 w-1 animate-pulse bg-blue-500" />
            </div>
          </div>
        )}

        {/* Streaming indicator with no text yet */}
        {isStreaming && !streamingText && (
          <div className="mb-4 flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 shadow-sm ring-1 ring-zinc-100 dark:bg-zinc-800 dark:ring-zinc-700">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Error display with retry */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <p>{error}</p>
            <button
              onClick={() => useChatStore.getState().setError(null)}
              className="mt-2 rounded bg-red-100 px-3 py-1 text-xs font-medium text-red-800 hover:bg-red-200 dark:bg-red-900 dark:text-red-200 dark:hover:bg-red-800"
            >
              Dismiss
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Drift warning banner */}
      {driftWarning && <DriftWarningBanner />}

      {/* Input */}
      <ChatInput />
    </div>
  );
}

function MessageBubble({
  message,
}: {
  message: import("@core/types").ChatMessage;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="mb-4 flex justify-center">
        <div className="max-w-[90%] rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <pre className="whitespace-pre-wrap font-sans">{message.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mb-4 flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? "rounded-br-sm bg-blue-500 text-white"
            : "rounded-bl-sm bg-white text-zinc-800 shadow-sm ring-1 ring-zinc-100 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700"
        }`}
      >
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 text-4xl">&#128736;</div>
      <h2 className="mb-2 text-lg font-semibold text-zinc-700 dark:text-zinc-200">
        UX Builder
      </h2>
      <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        Describe the product you want to build. I&apos;ll help you define goals,
        personas, entities, and boundaries before any code is written.
      </p>
    </div>
  );
}
