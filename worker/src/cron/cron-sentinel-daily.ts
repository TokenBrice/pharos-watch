import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";
import { runCronDurationWatchdog } from "./cron-duration-watchdog";
import { runMintBurnGrowthWatchdog } from "./mint-burn-growth-watchdog";
import { buildCronSentinelResult } from "./cron-sentinel-result";

export async function runDailyCronSentinel(
  db: D1Database,
  options: {
    nowSec: number;
    repairRunnerEnabled?: boolean;
    signal?: AbortSignal;
  },
) {
  return buildCronSentinelResult("daily", [
    { source: "growth", result: await runMintBurnGrowthWatchdog(db, options.signal) },
    { source: "duration", result: await runCronDurationWatchdog(db, options.signal) },
    {
      source: "repair-debt",
      result: await runWorkerRepairTaskRunner(db, {
        nowSec: options.nowSec,
        signal: options.signal,
        enabled: options.repairRunnerEnabled,
      }),
    },
  ]);
}
