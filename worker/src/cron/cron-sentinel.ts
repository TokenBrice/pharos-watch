import type { TelegramCreds } from "../lib/telegram";
import type { CronResult } from "../lib/cron-logger";
import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";
import { runCronStalenessWatchdog } from "./cron-staleness-watchdog";
import { runDigestPublicationWatchdog } from "./digest-publication-watchdog";
import { runCronDurationWatchdog } from "./cron-duration-watchdog";
import { runDexExitRouteTurnoverWatchdog } from "./dex-exit-route-turnover-watchdog";
import { runMintBurnGrowthWatchdog } from "./mint-burn-growth-watchdog";
import { runReservePostSyncWatchdog } from "./reserve-post-sync-watchdog";
import { buildCronSentinelResult, type CronSentinelSourceResult } from "./cron-sentinel-result";

export type CronSentinelMode = "status" | "daily" | "turnover" | "reserve-post-sync";

export interface CronSentinelOptions {
  mode: CronSentinelMode;
  nowSec?: number;
  operatorTelegramCreds?: TelegramCreds | null;
  repairRunnerEnabled?: boolean;
  signal?: AbortSignal;
}

export async function runCronSentinel(
  db: D1Database,
  options: CronSentinelOptions,
): Promise<CronResult> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1_000);
  const sourceResults: CronSentinelSourceResult[] = [];
  if (options.mode === "status") {
    sourceResults.push({
      source: "freshness",
      result: await runCronStalenessWatchdog(db, options.signal, {
        operatorTelegramCreds: options.operatorTelegramCreds ?? null,
      }),
    });
    sourceResults.push({
      source: "digest-publication",
      result: await runDigestPublicationWatchdog(
        db,
        nowSec,
        { operatorTelegramCreds: options.operatorTelegramCreds ?? null },
        options.signal,
      ),
    });
  } else if (options.mode === "daily") {
    sourceResults.push({ source: "growth", result: await runMintBurnGrowthWatchdog(db, options.signal) });
    sourceResults.push({ source: "duration", result: await runCronDurationWatchdog(db, options.signal) });
    sourceResults.push({
      source: "repair-debt",
      result: await runWorkerRepairTaskRunner(db, {
        nowSec,
        signal: options.signal,
        enabled: options.repairRunnerEnabled,
      }),
    });
  } else if (options.mode === "turnover") {
    sourceResults.push({
      source: "turnover",
      result: await runDexExitRouteTurnoverWatchdog(db, options.signal),
    });
  } else {
    sourceResults.push({
      source: "reserve-post-sync",
      result: await runReservePostSyncWatchdog(db, options.signal),
    });
  }

  return buildCronSentinelResult(options.mode, sourceResults);
}
