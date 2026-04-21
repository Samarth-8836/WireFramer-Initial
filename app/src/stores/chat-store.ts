"use client";

import { create } from "zustand";

import type { ChatMessage } from "@core/types";

interface ChatStore {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
  isBlocked: boolean;
  error: string | null;

  loadMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  appendStreamChunk: (text: string) => void;
  startStreaming: () => void;
  finalizeStream: (assistantMessage: ChatMessage) => void;
  cancelStream: () => void;
  setBlocked: (blocked: boolean) => void;
  setError: (error: string | null) => void;
  clear: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  streamingText: "",
  isStreaming: false,
  isBlocked: false,
  error: null,

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

  clear: () => {
    set({
      messages: [],
      streamingText: "",
      isStreaming: false,
      isBlocked: false,
      error: null,
    });
  },
}));
