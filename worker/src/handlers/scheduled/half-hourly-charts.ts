/**
 * Half-hourly charts trigger (16,46 * * * *):
 *   sync-stablecoin-charts (1)
 *
 * The charts writer keeps its own lightweight lane so the hourly full-write
 * path does not steal CPU budget from the heavier DEX scoring slot.
 * Successful writes remain cooldown-gated to once per hour.
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runHalfHourlyChartsSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const chartsResult = await runBestEffortScheduledJob(
    runtime,
    "half-hour charts slot",
    "sync-stablecoin-charts",
    (signal) => syncStablecoinCharts(runtime.db, signal),
  );
  if (chartsResult?.status === "error" || chartsResult == null) {
    console.warn("[cron] sync-stablecoin-charts did not complete cleanly");
  }
}
