"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useDocumentStore } from "@stores/document-store";

export function DocumentPanel() {
  const documents = useDocumentStore((s) => s.documents);
  const activeType = useDocumentStore((s) => s.activeDocumentType);

  const activeDoc = activeType ? documents[activeType] : undefined;

  // Only show the panel when there's at least one document.
  if (Object.keys(documents).length === 0) return null;

  return (
    <aside className="flex w-[45%] min-w-[320px] flex-col overflow-hidden bg-white dark:bg-zinc-900">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {Object.entries(documents).map(([type, doc]) =>
          doc ? (
            <TabButton
              key={type}
              label={formatDocType(type)}
              active={type === activeType}
              onClick={() =>
                useDocumentStore
                  .getState()
                  .setActiveDocumentType(
                    type as import("@core/types").DocumentType,
                  )
              }
            />
          ) : null,
        )}
      </div>

      {/* Document content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {activeDoc ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                {formatDocType(activeDoc.type)}
              </h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                v{activeDoc.version}
              </span>
            </div>
            <div className="markdown-body text-sm text-zinc-700 dark:text-zinc-200">
              <Markdown remarkPlugins={[remarkGfm]}>
                {activeDoc.content}
              </Markdown>
            </div>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-zinc-400">
            Select a document to view.
          </p>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          : "text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </button>
  );
}

function formatDocType(type: string): string {
  const map: Record<string, string> = {
    project_contract: "Project Contract",
    workflow_map: "Workflow Map",
    test_suite: "Test Suite",
    screen_inventory: "Screen Inventory",
  };
  return map[type] ?? type;
}
