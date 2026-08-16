import type { StatusCause, StatusResponse } from "@shared/types";
import type { DashboardIssueKind, DashboardNotice } from "@/lib/status/dashboard-types";

export const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    valueClassName: "text-emerald-700 dark:text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    badgeClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    valueClassName: "text-amber-700 dark:text-amber-400",
  },
  stale: {
    label: "Stale",
    badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    valueClassName: "text-red-700 dark:text-red-400",
  },
} as const;

export const STATUS_PRIORITY = { healthy: 0, degraded: 1, stale: 2 } as const;

function formatLocaleTimestampMs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { timeZoneName: "short" });
}

export function formatTimestampSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return formatLocaleTimestampMs(seconds * 1000);
}

export function formatTimestampMs(ms: number): string {
  if (!ms) return "—";
  return formatLocaleTimestampMs(ms);
}

export function formatTransitionLabel(transition: StatusResponse["timeline"][number] | null): string {
  if (!transition) return "No transition history";
  return `${transition.from ?? "init"} -> ${transition.to}`;
}

export function getStatusTone(status: StatusResponse["overallStatus"]) {
  return STATUS_TONE[status];
}

export const STATUS_OK_PILL_CLASS = STATUS_TONE.healthy.badgeClassName;

export function getSeverityBadgeClass(severity: StatusCause["severity"]): string {
  if (severity === "critical") return "bg-red-500/15 text-red-700 dark:text-red-400";
  if (severity === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

export function getIssueKindBadgeClass(kind: DashboardIssueKind): string {
  if (kind === "impacting") return "bg-red-500/15 text-red-700 dark:text-red-400";
  if (kind === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  if (kind === "maintenance") return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  return "bg-muted text-muted-foreground";
}

export function getNoticeTone(tone: DashboardNotice["tone"]): string {
  if (tone === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}
