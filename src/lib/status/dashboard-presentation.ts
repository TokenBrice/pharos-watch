import type { StatusCause, StatusResponse } from "@shared/types";
import type { StatusPageActionRisk } from "@shared/lib/api-endpoints";
import type { DashboardIssueKind, DashboardNotice } from "@/lib/status/dashboard-types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

export const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: SEVERITY_TONE_CLASS.ok.pill,
    valueClassName: SEVERITY_TONE_CLASS.ok.text,
  },
  degraded: {
    label: "Degraded",
    badgeClassName: SEVERITY_TONE_CLASS.watch.pill,
    valueClassName: SEVERITY_TONE_CLASS.watch.text,
  },
  stale: {
    label: "Stale",
    badgeClassName: SEVERITY_TONE_CLASS.alert.pill,
    valueClassName: SEVERITY_TONE_CLASS.alert.text,
  },
} as const;

export const STATUS_PRIORITY = { healthy: 0, degraded: 1, stale: 2 } as const;
export const STATUS_PAGE_RISK_LABELS: Record<StatusPageActionRisk, string> = {
  "read-only": "Read only",
  low: "Low risk",
  moderate: "Moderate risk",
  high: "High risk",
};

export const STATUS_PAGE_RISK_CLASSES: Record<StatusPageActionRisk, string> = {
  "read-only": SEVERITY_TONE_CLASS.ok.pill,
  low: SEVERITY_TONE_CLASS.info.pill,
  moderate: SEVERITY_TONE_CLASS.watch.pill,
  high: SEVERITY_TONE_CLASS.alert.pill,
};

export type OperationalTone = "ok" | "warning" | "error" | "unknown";

export const OPERATIONAL_PILL_CLASS: Record<OperationalTone, string> = {
  ok: `bg-emerald-500/15 ${SEVERITY_TONE_CLASS.ok.text}`,
  warning: `bg-amber-500/15 ${SEVERITY_TONE_CLASS.watch.text}`,
  error: `bg-red-500/15 ${SEVERITY_TONE_CLASS.alert.text}`,
  unknown: `bg-muted ${SEVERITY_TONE_CLASS.neutral.text}`,
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
  if (kind === "maintenance") return `bg-blue-500/15 ${SEVERITY_TONE_CLASS.info.text}`;
  return OPERATIONAL_PILL_CLASS.unknown;
}

export function getNoticeTone(tone: DashboardNotice["tone"]): string {
  if (tone === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}
