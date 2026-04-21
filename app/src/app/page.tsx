"use client";

import dynamic from "next/dynamic";

const AppShell = dynamic(
  () => import("@components/AppShell").then((m) => m.AppShell),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <p className="text-sm text-zinc-400">Loading UX Builder...</p>
      </div>
    ),
  },
);

export default function Home() {
  return <AppShell />;
}
