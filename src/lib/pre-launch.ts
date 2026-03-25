import type { DateHistoryEntry, LaunchMilestoneType, LaunchPhase } from "@shared/types";

// ---------------------------------------------------------------------------
// Launch-phase display constants
// ---------------------------------------------------------------------------

export const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

/** Phase → full badge class string (static for Tailwind scanner). */
export const PHASE_BADGE: Record<LaunchPhase, string> = {
  announced:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  testnet:
    "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  auditing:
    "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  beta: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "launching-soon":
    "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

/** Phase → ring color around logo node (static for Tailwind scanner). */
export const PHASE_RING: Record<LaunchPhase, string> = {
  announced: "ring-amber-500/40 hover:ring-amber-500/70",
  testnet: "ring-indigo-500/40 hover:ring-indigo-500/70",
  auditing: "ring-violet-500/40 hover:ring-violet-500/70",
  beta: "ring-emerald-500/40 hover:ring-emerald-500/70",
  "launching-soon": "ring-sky-500/40 hover:ring-sky-500/70",
};

// ---------------------------------------------------------------------------
// Milestone display constants
// ---------------------------------------------------------------------------

export const MILESTONE_TYPE_LABELS: Record<LaunchMilestoneType, string> = {
  announcement: "Announcement",
  milestone: "Milestone",
  delay: "Delay",
  partnership: "Partnership",
  regulatory: "Regulatory",
  audit: "Audit",
  testnet: "Testnet",
};

/** Milestone type → badge class string (static for Tailwind scanner). */
export const MILESTONE_TYPE_BADGE: Record<LaunchMilestoneType, string> = {
  announcement:
    "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  milestone:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  delay:
    "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  partnership:
    "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400",
  regulatory:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  audit:
    "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  testnet:
    "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
};

// ---------------------------------------------------------------------------
// Date drift display
// ---------------------------------------------------------------------------

export type DriftStatus = "on-track" | "pushed-once" | "pushed-multiple" | "overdue";

/** Drift status → badge class string (static for Tailwind scanner). */
export const DRIFT_STATUS_BADGE: Record<DriftStatus, string> = {
  "on-track":
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "pushed-once":
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "pushed-multiple":
    "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  overdue:
    "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
};

export const DRIFT_STATUS_LABEL: Record<DriftStatus, string> = {
  "on-track": "On Track",
  "pushed-once": "Pushed Once",
  "pushed-multiple": "Delayed",
  overdue: "Overdue",
};

export function getDriftStatus(
  dateHistory?: DateHistoryEntry[],
  expectedLaunchDate?: string,
): DriftStatus {
  if (!dateHistory || dateHistory.length === 0) return "on-track";
  if (expectedLaunchDate) {
    const end = parseFuzzyDate(expectedLaunchDate);
    if (end && end < new Date()) return "overdue";
  }
  if (dateHistory.length >= 2) return "pushed-multiple";
  return "pushed-once";
}

// ---------------------------------------------------------------------------
// Date helpers — parse YYYY, YYYY-MM, YYYY-QN
// ---------------------------------------------------------------------------

/** Convert a fuzzy date string to a Date for calculations. */
export function parseFuzzyDate(raw: string): Date | null {
  const qMatch = raw.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) {
    const year = Number(qMatch[1]);
    const quarter = Number(qMatch[2]);
    return new Date(year, (quarter - 1) * 3, 1);
  }
  const mMatch = raw.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    return new Date(Number(mMatch[1]), Number(mMatch[2]) - 1, 1);
  }
  const yMatch = raw.match(/^(\d{4})$/);
  if (yMatch) {
    return new Date(Number(yMatch[1]), 0, 1);
  }
  return null;
}

/** Format a fuzzy date string for display (e.g. "Q2 2026", "Mar 2026"). */
export function formatFuzzyDate(raw: string): string {
  const qMatch = raw.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) return `Q${qMatch[2]} ${qMatch[1]}`;
  const mMatch = raw.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const d = new Date(Number(mMatch[1]), Number(mMatch[2]) - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return raw;
}

/** Convert fuzzy date strings to a numeric score for chronological sorting. */
export function dateScore(raw?: string): number {
  if (!raw) return 999999;
  const q = raw.match(/^(\d{4})-Q(\d)$/);
  if (q) return Number(q[1]) * 13 + Number(q[2]) * 3 + 1;
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (m) return Number(m[1]) * 13 + Number(m[2]);
  const y = raw.match(/^(\d{4})$/);
  if (y) return Number(y[1]) * 13 + 13;
  return 999999;
}

