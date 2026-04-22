"use client";

import { useSessionStore } from "@stores/session-store";
import type { Phase2Stage } from "@core/types";

export function PhaseIndicator() {
  const phaseStates = useSessionStore((s) => s.phaseStates);
  const phase2Stage = useSessionStore((s) => s.phase2Stage);
  const phase1 = phaseStates["phase-1"];
  const phase2 = phaseStates["phase-2"];

  const phase1Status = phase1?.status ?? "active";
  const phase2Status = phase2?.status ?? "not_started";
  const isPhase2Active =
    phase2Status === "active" || phase2Status === "completing";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-6 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
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
        active={isPhase2Active && !phase2Stage}
      />
      {/* Phase 2 sub-stages — only surface once phase-2 is actually running. */}
      {isPhase2Active && phase2Stage && (
        <>
          <StageSeparator />
          <StageChip
            label="Design"
            state={stageChipState(phase2Stage, "design")}
          />
          <MiniArrow />
          <StageChip
            label="Wireframe"
            state={stageChipState(phase2Stage, "wireframe")}
          />
          <MiniArrow />
          <StageChip
            label="Test Suite"
            state={stageChipState(phase2Stage, "test_suite")}
          />
          <MiniArrow />
          <StageChip
            label="Automation"
            state={stageChipState(phase2Stage, "automated_tests")}
          />
        </>
      )}
    </div>
  );
}

type StageName = "design" | "wireframe" | "test_suite" | "automated_tests";
type ChipState = "pending" | "running" | "review" | "complete";

// Given the current global Phase 2 stage, decide how to render each
// stage chip — pending (grey), running (blue pulse), review (amber),
// or complete (green).
function stageChipState(
  current: Phase2Stage,
  stage: StageName,
): ChipState {
  const order: StageName[] = [
    "design",
    "wireframe",
    "test_suite",
    "automated_tests",
  ];
  const currentIdx = deriveStageIndex(current);
  const thisIdx = order.indexOf(stage);

  // After everything completes, current === "complete" → all green.
  if (current === "complete") return "complete";

  if (thisIdx < currentIdx) return "complete";
  if (thisIdx > currentIdx) return "pending";
  // Same stage — running vs review.
  if (current.endsWith("_running")) return "running";
  if (current.endsWith("_review")) return "review";
  return "pending";
}

function deriveStageIndex(stage: Phase2Stage): number {
  if (stage === "not_started") return -1;
  if (stage.startsWith("design")) return 0;
  if (stage.startsWith("wireframe")) return 1;
  if (stage.startsWith("test_suite")) return 2;
  if (stage.startsWith("automated_tests")) return 3;
  if (stage === "complete") return 4;
  return -1;
}

function StageChip({ label, state }: { label: string; state: ChipState }) {
  const colors: Record<ChipState, string> = {
    pending:
      "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-500",
    running:
      "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300 animate-pulse",
    review:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
    complete:
      "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${colors[state]}`}
    >
      {label}
      {state === "review" ? " ·" : ""}
      {state === "review" ? <span className="ml-1">review</span> : null}
      {state === "complete" ? <span className="ml-1">✓</span> : null}
    </span>
  );
}

function StageSeparator() {
  return (
    <span className="mx-2 h-4 w-px bg-zinc-300 dark:bg-zinc-600" />
  );
}

function MiniArrow() {
  return (
    <span className="text-[10px] text-zinc-300 dark:text-zinc-600">›</span>
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
