import type React from "react";
import { CRON_STATUS_COLORS } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { CronWorkbenchRow, FormattedCronDuration } from "@/lib/cron-workbench-model";
import { getLastSuccessfulRun } from "@/lib/status/cron-run-utils";
import { OPERATIONAL_PILL_CLASS, formatStatusTimestamp } from "@/lib/status/dashboard-presentation";

/**
 * Presentation helpers shared by the cron workbench surfaces: run-status tone
 * classes and the timestamp/duration/metadata formatters. Row severity uses
 * `OPERATOR_VERDICT_TONE`; nothing here defines a second state vocabulary.
 */
export const CRON_DETAIL_ID = "cron-selected-job-detail";
export const CRON_COLUMN_COUNT = 6;

export function getCronStatusColor(status: string | undefined): string {
  const statusColors: Readonly<Record<string, string>> = CRON_STATUS_COLORS;
  return status == null ? OPERATIONAL_PILL_CLASS.unknown : (statusColors[status] ?? OPERATIONAL_PILL_CLASS.unknown);
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
