import { formatUtcDayLabel } from "@shared/lib/format";
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

/** Phase → solid accent dot class (static for Tailwind scanner). */
export const PHASE_DOT: Record<LaunchPhase, string> = {
  announced: "bg-amber-500",
  testnet: "bg-indigo-500",
  auditing: "bg-violet-500",
  beta: "bg-emerald-500",
  "launching-soon": "bg-sky-500",
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
// Date helpers — parse YYYY, YYYY-MM, YYYY-MM-DD, YYYY-QN, YYYY-HN
// ---------------------------------------------------------------------------

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function isValidUtcDate(year: number, month: number, day: number): boolean {
  const date = utcDate(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function lastDayOfMonth(year: number, month: number): Date {
  return utcDate(year, month, 0);
}

/** Convert a fuzzy date string to a representative end-of-period Date for calculations. */
export function parseFuzzyDate(raw: string): Date | null {
  const dMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const year = Number(dMatch[1]);
    const month = Number(dMatch[2]);
    const day = Number(dMatch[3]);
    return isValidUtcDate(year, month, day) ? utcDate(year, month - 1, day) : null;
  }
  const hMatch = raw.match(/^(\d{4})-H([1-2])$/);
  if (hMatch) {
    const year = Number(hMatch[1]);
    const half = Number(hMatch[2]);
    return half === 1 ? utcDate(year, 5, 30) : utcDate(year, 11, 31);
  }
  const qMatch = raw.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const year = Number(qMatch[1]);
    const quarter = Number(qMatch[2]);
    return lastDayOfMonth(year, quarter * 3);
  }
  const mMatch = raw.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (mMatch) {
    return lastDayOfMonth(Number(mMatch[1]), Number(mMatch[2]));
  }
  const yMatch = raw.match(/^(\d{4})$/);
  if (yMatch) {
    return utcDate(Number(yMatch[1]), 11, 31);
  }
  return null;
}

/** Format a fuzzy date string for display (e.g. "Q2 2026", "Mar 2026"). */
export function formatFuzzyDate(raw: string): string {
  const dMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const parsed = parseFuzzyDate(raw);
    return parsed
      ? formatUtcDayLabel(parsed)
      : raw;
  }
  const hMatch = raw.match(/^(\d{4})-H([1-2])$/);
  if (hMatch) return `H${hMatch[2]} ${hMatch[1]}`;
  const qMatch = raw.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) return `Q${qMatch[2]} ${qMatch[1]}`;
  const mMatch = raw.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (mMatch) {
    const d = utcDate(Number(mMatch[1]), Number(mMatch[2]) - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return raw;
}

/** Convert fuzzy date strings to a numeric score for chronological sorting. */
export function dateScore(raw?: string): number {
  if (!raw) return Number.POSITIVE_INFINITY;
  return parseFuzzyDate(raw)?.getTime() ?? Number.POSITIVE_INFINITY;
}
