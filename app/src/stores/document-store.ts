"use client";

import { create } from "zustand";

import type { Document, DocumentType } from "@core/types";

interface DocumentStore {
  documents: Partial<Record<DocumentType, Document>>;
  activeDocumentType: DocumentType | null;

  setDocument: (doc: Document) => void;
  loadDocuments: (docs: Document[]) => void;
  setActiveDocumentType: (type: DocumentType | null) => void;
  clear: () => void;
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  documents: {},
  activeDocumentType: null,

  setDocument: (doc: Document) => {
    set((s) => ({
      documents: { ...s.documents, [doc.type]: doc },
      activeDocumentType: s.activeDocumentType ?? doc.type,
    }));
  },

  loadDocuments: (docs: Document[]) => {
    const map: Partial<Record<DocumentType, Document>> = {};
    for (const doc of docs) {
      map[doc.type] = doc;
    }
    const firstType = docs.length > 0 ? docs[0].type : null;
    set((s) => ({
      documents: map,
      activeDocumentType: s.activeDocumentType ?? firstType,
    }));
  },

  setActiveDocumentType: (type: DocumentType | null) => {
    set({ activeDocumentType: type });
  },

  clear: () => {
    set({ documents: {}, activeDocumentType: null });
  },
}));
