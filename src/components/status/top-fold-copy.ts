import type { StatusResponse } from "@shared/types";

export interface TopFoldCopy {
  eyebrow: string;
  title: string;
  body: string;
  shell: string;
  flareA: string;
  flareB: string;
  ruler: string;
  kicker: string;
  emphasis: "steady" | "recovery-hold";
}

const TOP_FOLD_COPY_BY_STATUS: Record<StatusResponse["overallStatus"], TopFoldCopy> = {
  healthy: {
    eyebrow: "Holding line",
    title: "Hold the line.",
    body: "Nothing is demanding intervention right now. Sweep the posture once before pressure builds.",
    shell: "bg-[linear-gradient(180deg,rgba(2,6,23,0.92),rgba(2,6,23,0.98))] border-emerald-500/18",
    flareA: "bg-emerald-400/14",
    flareB: "bg-emerald-300/10",
    ruler: "via-emerald-300/55",
    kicker: "text-emerald-300/85",
    emphasis: "steady",
  },
  degraded: {
    eyebrow: "Pressure building",
    title: "Take the shortest path.",
    body: "Start with the promoted action, then work down the hottest lane before the drift spreads.",
    shell: "bg-[linear-gradient(180deg,rgba(2,6,23,0.92),rgba(2,6,23,0.98))] border-amber-500/18",
    flareA: "bg-amber-400/14",
    flareB: "bg-amber-300/10",
    ruler: "via-amber-300/55",
    kicker: "text-amber-300/85",
    emphasis: "steady",
  },
  stale: {
    eyebrow: "Intervention required",
    title: "Contain the breach.",
    body: "Treat the rest of the page as supporting evidence until the lead blocker is under control.",
    shell: "bg-[linear-gradient(180deg,rgba(2,6,23,0.92),rgba(2,6,23,0.98))] border-red-500/18",
    flareA: "bg-red-400/16",
    flareB: "bg-red-300/10",
    ruler: "via-red-300/55",
    kicker: "text-red-300/88",
    emphasis: "steady",
  },
} as const;

const RECOVERY_HOLD_COPY: Record<Exclude<StatusResponse["rawOverallStatus"], "stale">, TopFoldCopy> = {
  healthy: {
    eyebrow: "Recovery confirmation",
    title: "Verify the rebound.",
    body: "Raw signals have recovered, but the stale hold has not cleared yet. Use the next sweep to confirm the recovery is durable.",
    shell: "bg-[linear-gradient(180deg,rgba(2,6,23,0.92),rgba(2,6,23,0.98))] border-amber-500/18",
    flareA: "bg-amber-400/14",
    flareB: "bg-red-300/10",
    ruler: "via-amber-300/55",
    kicker: "text-amber-300/85",
    emphasis: "recovery-hold",
  },
  degraded: {
    eyebrow: "Recovery holding",
    title: "Hold the recovery.",
    body: "Raw signals have improved, but the stale hold is still active. Focus on the remaining blockers and wait for the next confirming sweep.",
    shell: "bg-[linear-gradient(180deg,rgba(2,6,23,0.92),rgba(2,6,23,0.98))] border-amber-500/18",
    flareA: "bg-amber-400/14",
    flareB: "bg-red-300/10",
    ruler: "via-amber-300/55",
    kicker: "text-amber-300/85",
    emphasis: "recovery-hold",
  },
};

function getStatusSeverity(status: StatusResponse["overallStatus"]): number {
  if (status === "healthy") return 0;
  if (status === "degraded") return 1;
  return 2;
}

export function isRecoveryHold(
  overallStatus: StatusResponse["overallStatus"],
  rawStatus: StatusResponse["rawOverallStatus"],
): boolean {
  return getStatusSeverity(overallStatus) > getStatusSeverity(rawStatus);
}

export function getTopFoldCopy(
  overallStatus: StatusResponse["overallStatus"],
  rawStatus: StatusResponse["rawOverallStatus"],
): TopFoldCopy {
  if (overallStatus === "stale" && rawStatus !== "stale" && isRecoveryHold(overallStatus, rawStatus)) {
    return RECOVERY_HOLD_COPY[rawStatus];
  }

  if (overallStatus === "degraded" && rawStatus === "healthy") {
    return {
      ...TOP_FOLD_COPY_BY_STATUS.degraded,
      eyebrow: "Recovery holding",
      title: "Verify the rebound.",
      body: "Raw signals are healthy again, but the degraded hold has not cleared yet. Sweep the remaining lanes before standing down.",
      emphasis: "recovery-hold",
    };
  }

  return TOP_FOLD_COPY_BY_STATUS[overallStatus];
}
