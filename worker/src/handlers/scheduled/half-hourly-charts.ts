/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-stablecoin-charts (1)
 *
 * The charts writer keeps its own lightweight lane so the hourly full-write
 * path does not steal CPU budget from the heavier DEX scoring slot.
 * Scheduled deliveries share one retryable publication bucket per hour.
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour charts slot", {
    job: "sync-stablecoin-charts",
    run: (signal) => syncStablecoinCharts(runtime.db, signal, { scheduledAtSec: runtime.slotStartedAt }),
  });
}
