import type React from "react";
import { CRON_STATUS_COLORS } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import type {
  CronWorkbenchRow,
  CronWorkbenchState,
  FormattedCronDuration,
} from "@/lib/cron-workbench-model";
import { getLastSuccessfulRun } from "@/lib/status/cron-run-utils";
import { OPERATIONAL_PILL_CLASS, formatStatusTimestamp } from "@/lib/status/dashboard-presentation";

/**
 * Presentation vocabulary shared by the cron workbench surfaces: state labels,
 * tone classes, and the timestamp/duration/metadata formatters. Pure — no JSX
 * beyond the duration span, no React state.
 */
export const CRON_DETAIL_ID = "cron-selected-job-detail";
export const CRON_COLUMN_COUNT = 9;

export const FILTER_FIELD_CLASS_NAME =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

export const CRON_STATE_LABELS: Readonly<Record<CronWorkbenchState, string>> = {
  unhealthy: "Unavailable",
  degraded: "Run warning",
  unknown: "Unknown",
  skipped: "Skipped",
  running: "Running",
  healthy: "Healthy",
};

export function getCronStatusColor(status: string | undefined): string {
  const statusColors: Readonly<Record<string, string>> = CRON_STATUS_COLORS;
  return status == null ? OPERATIONAL_PILL_CLASS.unknown : (statusColors[status] ?? OPERATIONAL_PILL_CLASS.unknown);
}

export function getStateBadgeClass(state: CronWorkbenchState): string {
  if (state === "unhealthy") return "bg-state-danger-solid/15 text-state-danger-strong";
  if (state === "degraded") return "bg-state-warn-solid/15 text-state-warn-strong";
  if (state === "skipped") return OPERATIONAL_PILL_CLASS.unknown;
  if (state === "running") return "bg-state-info-solid/15 text-state-info-strong";
  // raw: neutral grey pill, no state token
  if (state === "unknown") return "bg-slate-500/15 text-slate-800 dark:text-slate-300";
  return "bg-state-positive-solid/15 text-state-positive-strong";
}

export function getRowTone(state: CronWorkbenchState): string {
  if (state === "unhealthy") return "border-l-state-danger-solid/70";
  if (state === "degraded") return "border-l-state-warn-solid/70";
  if (state === "skipped") return "border-l-muted-foreground/40";
  if (state === "running") return "border-l-state-info-solid/70";
  if (state === "unknown") return "border-l-slate-500/60";
  return "border-l-state-positive-solid/60";
}

export function formatLastRun(row: CronWorkbenchRow, nowSeconds: number): string {
  if (!row.cron.lastRun) return row.cron.telemetryUnknown ? "Unknown" : "No runs";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.lastRun.startedAt))} ago`;
}

export function formatLastGood(row: CronWorkbenchRow, nowSeconds: number): string {
  if (row.cron.telemetryUnknown) return `Unknown${row.cron.telemetryUnknownReason ? `: ${row.cron.telemetryUnknownReason}` : ""}`;
  const lastSuccessfulRun = getLastSuccessfulRun(row.cron.recentRuns ?? []);
  if (!lastSuccessfulRun) return "No successful run in recent history";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - lastSuccessfulRun.startedAt))} ago`;
}

export function formatTimestamp(timestampSeconds: number | null | undefined): string {
  return formatStatusTimestamp(timestampSeconds, { fallback: "Unknown", timeZoneName: "short" });
}

export function formatDurationValue(
  duration: FormattedCronDuration | null,
  unavailableLabel: "Unknown" | "N/A" = "Unknown",
): React.ReactNode {
  if (!duration) return unavailableLabel;
  return (
    <span title={duration.exactLabel}>
      {duration.label}
      <span className="sr-only">; exact {duration.exactLabel}</span>
    </span>
  );
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function formatPrerequisiteEvidence(skippedReason: string | null): string | null {
  for (const [prefix, label] of [
    ["upstream-incomplete:", "prerequisite incomplete"],
    ["upstream-failure:", "prerequisite failed"],
    ["upstream-blocked:", "prerequisite blocked"],
  ] as const) {
    if (skippedReason?.startsWith(prefix)) return `${label}: ${skippedReason.slice(prefix.length)}`;
  }
  return null;
}
