import type { StatusResponse } from "@shared/types";

/**
 * Severity score for sorting admin cron cards. Higher = render first.
 * 2 = unhealthy/error/in-flight-stale, 1 = degraded or telemetry-unknown bootstrap, 0 = healthy.
 */
export function getCronSeverity(cron: StatusResponse["crons"][string]): number {
  if (cron.telemetryUnknown) return 1;
  if (!cron.healthy || cron.lastRun?.status === "error" || cron.inFlight?.stale) return 2;
  if (cron.lastRun?.status === "degraded") return 1;
  return 0;
}
