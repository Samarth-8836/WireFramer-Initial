"use client";

import { useCallback, useRef } from "react";

import { useChatStore } from "@stores/chat-store";
import { useDocumentStore } from "@stores/document-store";
import { useSessionStore } from "@stores/session-store";

// ---------------------------------------------------------------------------
// SSE client hook
//
// Consumes the SSE stream from POST /api/chat (or /api/phase/complete) and
// dispatches each event type to the appropriate Zustand store.
//
// Wire format (from SSEWriter on the server):
//   event: <type>\ndata: <json>\n\n
//
// Event types we handle:
//   chunk      — { text }           → chatStore.appendStreamChunk
//   document   — { type, content, version, ... } → documentStore.setDocument
//   phase      — { ... }            → sessionStore.updatePhaseState
//   meta       — { event, ... }     → session_info → save sessionId
//   error      — { error, fatal? }  → chatStore.setError
//   complete   — {}                 → finalize stream
//   test_results — { ... }          → chatStore.addMessage (as system msg)
// ---------------------------------------------------------------------------

interface SendMessageOpts {
  sessionId?: string | null;
  message: string;
  screenRef?: string | null;
}

interface UseSSEReturn {
  sendMessage: (opts: SendMessageOpts) => void;
  completePhase: (sessionId: string) => void;
  isConnected: boolean;
}

export function useSSE(): UseSSEReturn {
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const connectedRef = useRef(false);

  const sendMessage = useCallback(
    (opts: SendMessageOpts) => {
      // Abort any in-flight stream.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const chatStore = useChatStore.getState();
      const sessionStore = useSessionStore.getState();

      // Add user message to the chat immediately (optimistic).
      chatStore.addMessage({
        id: `temp-${Date.now()}`,
        sessionId: opts.sessionId ?? "",
        phaseId: "phase-1",
        role: "user",
        type: "chat",
        content: opts.message,
        metadata: {
          screenReference: null,
          generationContext: null,
          operationId: null,
          stale: false,
        },
        createdAt: new Date().toISOString(),
      });

      chatStore.startStreaming();
      sessionIdRef.current = opts.sessionId ?? null;

      void consumeSSEStream(
        "/api/chat",
        {
          sessionId: opts.sessionId ?? undefined,
          message: opts.message,
          screenRef: opts.screenRef ?? undefined,
        },
        controller.signal,
        (newSessionId) => {
          sessionIdRef.current = newSessionId;
          // Refresh the session list so the sidebar shows the new session.
          void sessionStore.loadSessions();
        },
      );
    },
    [],
  );

  const completePhase = useCallback((sessionId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    useChatStore.getState().startStreaming();

    void consumeSSEStream(
      "/api/phase/complete",
      { sessionId },
      controller.signal,
      undefined,
    );
  }, []);

  return {
    sendMessage,
    completePhase,
    isConnected: connectedRef.current,
  };
}

// Return the current session ID ref for external reads.
export function getCurrentSessionId(): string | null {
  return null; // Consumers read from useSessionStore instead.
}

// ---------------------------------------------------------------------------
// Internal: fetch-based SSE consumer
// ---------------------------------------------------------------------------

async function consumeSSEStream(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onNewSession?: (sessionId: string) => void,
): Promise<void> {
  const chatStore = useChatStore.getState;
  const docStore = useDocumentStore.getState;
  const sessionStore = useSessionStore.getState;

  let assistantText = "";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      chatStore().setError(`Server error: ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames: "event: TYPE\ndata: JSON\n\n"
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.trim()) continue;
        const parsed = parseSSEFrame(frame);
        if (!parsed) continue;

        switch (parsed.type) {
          case "chunk": {
            const text = (parsed.data as { text: string }).text ?? "";
            assistantText += text;
            chatStore().appendStreamChunk(text);
            break;
          }

          case "document": {
            const doc = parsed.data as {
              type: string;
              content: string;
              version: number;
            };
            docStore().setDocument({
              id: `doc-${doc.type}-${doc.version}`,
              sessionId: sessionStore().activeSessionId ?? "",
              phaseId: "phase-1",
              type: doc.type as import("@core/types").DocumentType,
              content: doc.content,
              structuredData: "",
              version: doc.version,
              status: "active",
              createdAt: new Date().toISOString(),
              lastModifiedAt: new Date().toISOString(),
            });
            break;
          }

          case "meta": {
            const meta = parsed.data as {
              event?: string;
              sessionId?: string;
            };
            if (meta.event === "session_info" && meta.sessionId) {
              sessionStore().addSession({
                id: meta.sessionId,
                title: "New Session",
                currentPhaseId: "phase-1",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: "active",
              });
              sessionStore().setActiveSession(meta.sessionId);
              onNewSession?.(meta.sessionId);
            }
            break;
          }

          case "phase": {
            // Server emits `{phaseId, status, detail?}`. Construct a
            // minimal PhaseState so the phase indicator reflects the new
            // status immediately (previously the client only checked
            // `phaseId` but some emitters sent `from/to` and the event
            // was dropped, leaving the indicator stuck on Phase 1).
            const phase = parsed.data as {
              phaseId?: string;
              status?: import("@core/types").PhaseStatus;
              detail?: string;
            };
            if (phase.phaseId && phase.status) {
              const now = new Date().toISOString();
              const existing =
                sessionStore().phaseStates[phase.phaseId] ?? null;
              sessionStore().updatePhaseState(phase.phaseId, {
                sessionId: sessionStore().activeSessionId ?? "",
                phaseId: phase.phaseId as import("@core/types").PhaseId,
                status: phase.status,
                enteredAt:
                  phase.status === "active" || phase.status === "completing"
                    ? (existing?.enteredAt ?? now)
                    : (existing?.enteredAt ?? null),
                completedAt:
                  phase.status === "complete"
                    ? now
                    : (existing?.completedAt ?? null),
                suspendedAt:
                  phase.status === "suspended"
                    ? now
                    : (existing?.suspendedAt ?? null),
              });
            }
            break;
          }

          case "test_results": {
            // Show validation results as a system message.
            const resultsStr =
              typeof parsed.data === "string"
                ? parsed.data
                : JSON.stringify(parsed.data, null, 2);
            chatStore().addMessage({
              id: `validation-${Date.now()}`,
              sessionId: sessionStore().activeSessionId ?? "",
              phaseId: "phase-1",
              role: "system",
              type: "validation_result",
              content: resultsStr,
              metadata: {
                screenReference: null,
                generationContext: null,
                operationId: null,
                stale: false,
              },
              createdAt: new Date().toISOString(),
            });
            break;
          }

          case "drift": {
            const drift = parsed.data as {
              classification: "FLAG" | "DRIFT";
              type: string;
              reason: string;
            };
            chatStore().showDriftWarning(drift);
            break;
          }

          case "progress": {
            // Progress events are informational. Surface them as transient
            // system messages so the user sees operation progress.
            const progress = parsed.data as {
              operationId: string;
              status: string;
              detail?: string;
            };
            if (progress.detail) {
              chatStore().addMessage({
                id: `progress-${progress.operationId}-${Date.now()}`,
                sessionId: sessionStore().activeSessionId ?? "",
                phaseId: "phase-2",
                role: "system",
                type: "system_notification",
                content: `[${progress.operationId}] ${progress.detail}`,
                metadata: {
                  screenReference: null,
                  generationContext: null,
                  operationId: null,
                  stale: false,
                },
                createdAt: new Date().toISOString(),
              });
            }
            break;
          }

          case "error": {
            const err = parsed.data as { error: string; fatal?: boolean };
            chatStore().setError(err.error);
            break;
          }

          case "complete": {
            // Finalize the assistant message.
            if (assistantText) {
              chatStore().finalizeStream({
                id: `assistant-${Date.now()}`,
                sessionId: sessionStore().activeSessionId ?? "",
                phaseId: "phase-1",
                role: "assistant",
                type: "chat",
                content: assistantText,
                metadata: {
                  screenReference: null,
                  generationContext: null,
                  operationId: null,
                  stale: false,
                },
                createdAt: new Date().toISOString(),
              });
            } else {
              chatStore().cancelStream();
            }
            assistantText = "";
            // Refresh the session list to pick up title updates.
            void sessionStore().loadSessions();
            break;
          }
        }
      }
    }

    // Stream ended without a "complete" event — finalize anyway.
    if (chatStore().isStreaming) {
      if (assistantText) {
        chatStore().finalizeStream({
          id: `assistant-${Date.now()}`,
          sessionId: sessionStore().activeSessionId ?? "",
          phaseId: "phase-1",
          role: "assistant",
          type: "chat",
          content: assistantText,
          metadata: {
            screenReference: null,
            generationContext: null,
            operationId: null,
            stale: false,
          },
          createdAt: new Date().toISOString(),
        });
      } else {
        chatStore().cancelStream();
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      chatStore().cancelStream();
      return;
    }
    chatStore().setError(
      `Connection error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Parse a single SSE frame: "event: TYPE\ndata: JSON"
// ---------------------------------------------------------------------------

function parseSSEFrame(
  frame: string,
): { type: string; data: unknown } | null {
  let type = "";
  let dataStr = "";

  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) {
      type = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataStr = line.slice(6);
    }
  }

  if (!type || !dataStr) return null;

  try {
    return { type, data: JSON.parse(dataStr) };
  } catch {
    return { type, data: dataStr };
  }
}
