"use client";

import { create } from "zustand";

import type { ChatMessage } from "@core/types";

export interface DriftWarning {
  classification: "FLAG" | "DRIFT";
  type: string;
  reason: string;
}

interface ChatStore {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
  isBlocked: boolean;
  error: string | null;
  driftWarning: DriftWarning | null;

  loadMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  appendStreamChunk: (text: string) => void;
  startStreaming: () => void;
  finalizeStream: (assistantMessage: ChatMessage) => void;
  cancelStream: () => void;
  setBlocked: (blocked: boolean) => void;
  setError: (error: string | null) => void;
  showDriftWarning: (warning: DriftWarning) => void;
  dismissDriftWarning: () => void;
  clear: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  streamingText: "",
  isStreaming: false,
  isBlocked: false,
  error: null,
  driftWarning: null,

  loadMessages: (messages: ChatMessage[]) => {
    set({ messages, streamingText: "", isStreaming: false });
  },

  addMessage: (message: ChatMessage) => {
    set((s) => ({ messages: [...s.messages, message] }));
  },

  appendStreamChunk: (text: string) => {
    set((s) => ({ streamingText: s.streamingText + text }));
  },

  startStreaming: () => {
    set({ streamingText: "", isStreaming: true, isBlocked: true, error: null });
  },

  finalizeStream: (assistantMessage: ChatMessage) => {
    set((s) => ({
      messages: [...s.messages, assistantMessage],
      streamingText: "",
      isStreaming: false,
      isBlocked: false,
    }));
  },

  cancelStream: () => {
    set({ streamingText: "", isStreaming: false, isBlocked: false });
  },

  setBlocked: (blocked: boolean) => {
    set({ isBlocked: blocked });
  },

  setError: (error: string | null) => {
    set({ error, isBlocked: false, isStreaming: false });
  },

  showDriftWarning: (warning: DriftWarning) => {
    set({ driftWarning: warning, isBlocked: true, isStreaming: false });
  },

  dismissDriftWarning: () => {
    set({ driftWarning: null, isBlocked: false });
  },

  clear: () => {
    set({
      messages: [],
      streamingText: "",
      isStreaming: false,
      isBlocked: false,
      error: null,
      driftWarning: null,
    });
  },
}));
