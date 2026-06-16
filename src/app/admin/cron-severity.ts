import type { StatusResponse } from "@shared/types";
import type { CronGroup } from "./sections/cron-lane-types";

export type CronState = "unhealthy" | "degraded" | "running" | "unknown" | "healthy";

/**
 * Classify a cron into a canonical state. Both severity score and row tone derive from this.
 * - unknown: telemetry not yet available (bootstrap) — highest precedence
 * - unhealthy: not healthy, error status, or in-flight stale
 * - degraded: last run was degraded
 * - running: currently in-flight and not stale
 * - healthy: all clear
 */
export function classifyCronState(cron: StatusResponse["crons"][string]): CronState {
  if (cron.telemetryUnknown) return "unknown";
  if (!cron.healthy || cron.lastRun?.status === "error" || cron.inFlight?.stale) return "unhealthy";
  if (cron.lastRun?.status === "degraded") return "degraded";
  if (cron.inFlight && !cron.inFlight.stale) return "running";
  return "healthy";
}

/**
 * Severity score for sorting admin cron rows. Higher = render first.
 * 2 = unhealthy/error/in-flight-stale, 1 = degraded or telemetry-unknown bootstrap, 0 = healthy/running.
 */
export function getCronSeverity(cron: StatusResponse["crons"][string]): number {
  const state = classifyCronState(cron);
  if (state === "unhealthy") return 2;
  if (state === "degraded" || state === "unknown") return 1;
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
