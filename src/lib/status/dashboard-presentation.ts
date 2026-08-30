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

export type OperationalTone = "ok" | "warning" | "error" | "unknown";

export const OPERATIONAL_PILL_CLASS: Record<OperationalTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  error: "bg-red-500/15 text-red-700 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

type StatusTimeZoneName = Intl.DateTimeFormatOptions["timeZoneName"];

function formatLocaleTimestampMs(ms: number, timeZoneName?: StatusTimeZoneName): string {
  return timeZoneName
    ? new Date(ms).toLocaleString(undefined, { timeZoneName })
    : new Date(ms).toLocaleString();
}

export function formatTimestampSeconds(
  seconds: number | null | undefined,
  options?: { timeZoneName?: StatusTimeZoneName },
): string {
  if (seconds == null) return "—";
  return formatLocaleTimestampMs(seconds * 1000, options ? options.timeZoneName : "short");
}

export function formatStatusTimestamp(
  epochSeconds: number | null | undefined,
  { fallback = "—", timeZoneName }: { fallback?: string; timeZoneName?: StatusTimeZoneName } = {},
): string {
  if (epochSeconds == null) return fallback;
  return formatTimestampSeconds(epochSeconds, { timeZoneName });
}

export function formatTimestampMs(ms: number): string {
  if (!ms) return "—";
  return formatLocaleTimestampMs(ms, "short");
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
  if (severity === "critical") return OPERATIONAL_PILL_CLASS.error;
  if (severity === "warning") return OPERATIONAL_PILL_CLASS.warning;
  return OPERATIONAL_PILL_CLASS.unknown;
}

export function getIssueKindBadgeClass(kind: DashboardIssueKind): string {
  if (kind === "impacting") return OPERATIONAL_PILL_CLASS.error;
  if (kind === "warning") return OPERATIONAL_PILL_CLASS.warning;
  if (kind === "maintenance") return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  return OPERATIONAL_PILL_CLASS.unknown;
}

export function getNoticeTone(tone: DashboardNotice["tone"]): string {
  if (tone === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}
