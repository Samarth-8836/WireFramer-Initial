"use client";

import { useSessionStore } from "@stores/session-store";

export function PhaseIndicator() {
  const phaseStates = useSessionStore((s) => s.phaseStates);
  const phase1 = phaseStates["phase-1"];
  const phase2 = phaseStates["phase-2"];

  const phase1Status = phase1?.status ?? "active";
  const phase2Status = phase2?.status ?? "not_started";

  return (
    <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-6 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
      <PhaseStep
        label="Phase 1"
        subtitle="Define"
        status={phase1Status}
        active={phase1Status === "active" || phase1Status === "completing"}
      />
      <Arrow />
      <PhaseStep
        label="Phase 2"
        subtitle="Generate"
        status={phase2Status}
        active={phase2Status === "active" || phase2Status === "completing"}
      />
    </div>
  );
}

function PhaseStep({
  label,
  subtitle,
  status,
  active,
}: {
  label: string;
  subtitle: string;
  status: string;
  active: boolean;
}) {
  const isComplete = status === "complete";

  let dotClass = "bg-zinc-300 dark:bg-zinc-600";
  if (active) dotClass = "bg-blue-500 ring-2 ring-blue-200 dark:ring-blue-900";
  if (isComplete) dotClass = "bg-green-500";

  return (
    <div className="flex items-center gap-2">
      <div className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
      <div className="flex items-baseline gap-1.5">
        <span
          className={`text-sm font-medium ${
            active
              ? "text-blue-600 dark:text-blue-400"
              : isComplete
                ? "text-green-600 dark:text-green-400"
                : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          {label}
        </span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {subtitle}
        </span>
        {isComplete && (
          <span className="text-xs text-green-500">&#10003;</span>
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      className="h-4 w-4 text-zinc-300 dark:text-zinc-600"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}
