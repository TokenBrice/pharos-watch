import type { TelegramCreds } from "../lib/telegram";
import type { CronResult } from "../lib/cron-logger";
import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";
import { runCronStalenessWatchdog } from "./cron-staleness-watchdog";
import { runDigestPublicationWatchdog } from "./digest-publication-watchdog";
import { runCronDurationWatchdog } from "./cron-duration-watchdog";
import { runDexExitRouteTurnoverWatchdog } from "./dex-exit-route-turnover-watchdog";
import { runMintBurnGrowthWatchdog } from "./mint-burn-growth-watchdog";
import { runReservePostSyncWatchdog } from "./reserve-post-sync-watchdog";
import { runCronSentinelSources } from "./cron-sentinel-result";

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
  const sources: Parameters<typeof runCronSentinelSources>[2][number][] = [];
  if (options.mode === "status") {
    sources.push({
      source: "freshness",
      run: () => runCronStalenessWatchdog(db, options.signal, {
        operatorTelegramCreds: options.operatorTelegramCreds ?? null,
      }),
    });
    sources.push({
      source: "digest-publication",
      run: () => runDigestPublicationWatchdog(
        db,
        nowSec,
        { operatorTelegramCreds: options.operatorTelegramCreds ?? null },
        options.signal,
      ),
    });
  } else if (options.mode === "daily") {
    sources.push({ source: "growth", run: () => runMintBurnGrowthWatchdog(db, options.signal) });
    sources.push({ source: "duration", run: () => runCronDurationWatchdog(db, options.signal) });
    sources.push({
      source: "repair-debt",
      run: () => runWorkerRepairTaskRunner(db, {
        nowSec,
        signal: options.signal,
        enabled: options.repairRunnerEnabled,
      }),
    });
  } else if (options.mode === "turnover") {
    sources.push({
      source: "turnover",
      run: () => runDexExitRouteTurnoverWatchdog(db, options.signal),
    });
  } else {
    sources.push({
      source: "reserve-post-sync",
      run: () => runReservePostSyncWatchdog(db, options.signal),
    });
  }

  return runCronSentinelSources(db, options.mode, sources, nowSec, options.signal);
}
