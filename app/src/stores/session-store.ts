"use client";

import { create } from "zustand";

import type {
  ChatMessage,
  Document,
  Phase2Stage,
  PhaseState,
  Session,
} from "@core/types";

export interface SessionSnapshot {
  session: Session;
  phaseStates: Record<string, PhaseState | null>;
  documents: Document[];
  messages: Record<string, ChatMessage[]>;
}

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  phaseStates: Record<string, PhaseState | null>;
  phase2Stage: Phase2Stage | null;
  isLoading: boolean;

  loadSessions: () => Promise<void>;
  setActiveSession: (id: string) => Promise<SessionSnapshot | null>;
  addSession: (session: Session) => void;
  updateSessionTitle: (id: string, title: string) => void;
  updatePhaseState: (phaseId: string, state: PhaseState) => void;
  setPhase2Stage: (stage: Phase2Stage | null) => void;
  clearActive: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  phaseStates: {},
  phase2Stage: null,
  isLoading: false,

  loadSessions: async () => {
    set({ isLoading: true });
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      set({ sessions: data.sessions ?? [] });
    } finally {
      set({ isLoading: false });
    }
  },

  setActiveSession: async (id: string): Promise<SessionSnapshot | null> => {
    set({ activeSessionId: id, phase2Stage: null });
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) return null;
      const data = (await res.json()) as SessionSnapshot;
      set({
        phaseStates: data.phaseStates ?? {},
        phase2Stage: data.session?.phase2Stage ?? null,
      });
      return data;
    } catch {
      // Network error — keep the session selected, hydration will be partial.
      return null;
    }
  },

  addSession: (session: Session) => {
    set((s) => ({
      sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
      activeSessionId: session.id,
    }));
  },

  updateSessionTitle: (id: string, title: string) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  },

  updatePhaseState: (phaseId: string, state: PhaseState) => {
    set((s) => ({
      phaseStates: { ...s.phaseStates, [phaseId]: state },
    }));
  },

  setPhase2Stage: (stage: Phase2Stage | null) => {
    set({ phase2Stage: stage });
  },

  clearActive: () => {
    set({ activeSessionId: null, phaseStates: {}, phase2Stage: null });
  },
}));
