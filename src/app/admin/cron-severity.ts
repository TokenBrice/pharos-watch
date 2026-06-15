import type { StatusResponse } from "@shared/types";
import type { CronGroup } from "./sections/cron-lane-types";

/**
 * Severity score for sorting admin cron rows. Higher = render first.
 * 2 = unhealthy/error/in-flight-stale, 1 = degraded or telemetry-unknown bootstrap, 0 = healthy.
 */
export function getCronSeverity(cron: StatusResponse["crons"][string]): number {
  if (cron.telemetryUnknown) return 1;
  if (!cron.healthy || cron.lastRun?.status === "error" || cron.inFlight?.stale) return 2;
  if (cron.lastRun?.status === "degraded") return 1;
  return 0;
}

/**
 * Sort cron groups (and the entries within each group) by descending severity.
 * Pure helper extracted from the render body so the result can be memoized and
 * unit-tested. Returns new arrays; does not mutate the input.
 */
export function sortCronGroupsBySeverity(cronGroups: readonly CronGroup[]): CronGroup[] {
  return cronGroups
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort(([, a], [, b]) => getCronSeverity(b) - getCronSeverity(a)),
    }))
    .sort((a, b) => {
      const aSeverity = Math.max(...a.entries.map(([, cron]) => getCronSeverity(cron)), 0);
      const bSeverity = Math.max(...b.entries.map(([, cron]) => getCronSeverity(cron)), 0);
      return bSeverity - aSeverity;
    });
}
