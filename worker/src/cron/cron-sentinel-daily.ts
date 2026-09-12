import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";
import { runCronDurationWatchdog } from "./cron-duration-watchdog";
import { runMintBurnGrowthWatchdog } from "./mint-burn-growth-watchdog";
import { runCronSentinelSources } from "./cron-sentinel-result";

export async function runDailyCronSentinel(
  db: D1Database,
  options: {
    nowSec: number;
    repairRunnerEnabled?: boolean;
    signal?: AbortSignal;
  },
) {
  return runCronSentinelSources(db, "daily", [
    { source: "growth", run: () => runMintBurnGrowthWatchdog(db, options.signal) },
    { source: "duration", run: () => runCronDurationWatchdog(db, options.signal) },
    {
      source: "repair-debt",
      run: () => runWorkerRepairTaskRunner(db, {
        nowSec: options.nowSec,
        signal: options.signal,
        enabled: options.repairRunnerEnabled,
      }),
    },
  ], options.nowSec, options.signal);
}
