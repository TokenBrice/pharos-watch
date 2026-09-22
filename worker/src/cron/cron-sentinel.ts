import type { TelegramCreds } from "../lib/telegram";
import type { CronResult } from "../lib/cron-logger";
import { runCronStalenessWatchdog } from "./cron-staleness-watchdog";
import { runDigestPublicationWatchdog } from "./digest-publication-watchdog";
import { runDexExitRouteTurnoverWatchdog } from "./dex-exit-route-turnover-watchdog";
import { runReservePostSyncWatchdog } from "./reserve-post-sync-watchdog";
import { runCronSentinelSources, type CronSentinelMode } from "./cron-sentinel-result";

/** `daily` is reached only through `runDailyCronSentinel`, never dispatched here. */
export type CronSentinelDispatchMode = Exclude<CronSentinelMode, "daily">;

export interface CronSentinelOptions {
  mode: CronSentinelDispatchMode;
  nowSec?: number;
  operatorTelegramCreds?: TelegramCreds | null;
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
