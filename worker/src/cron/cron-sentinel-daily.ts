import { runCronSentinelSources } from "./cron-sentinel-result";
import type { TelegramCreds } from "../telegram/delivery/telegram";

export interface DailyCronSentinelOptions {
  nowSec: number;
  repairRunnerEnabled?: boolean;
  signal?: AbortSignal;
  mintBurnDisabledIds?: readonly string[];
  mintBurnDisabledSymbols?: readonly string[];
  operatorTelegramCreds?: TelegramCreds | null;
}

export function getDailyCronSentinelSources(db: D1Database, options: DailyCronSentinelOptions) {
  return [
    {
      source: "supply-reconciliation",
      run: async () => (await import("./mint-burn-reconciliation-watchdog")).runMintBurnReconciliationWatchdog(db, {
        nowSec: options.nowSec,
        operatorTelegramCreds: options.operatorTelegramCreds ?? null,
        signal: options.signal,
      }),
    },
    {
      source: "growth",
      run: async () => (await import("./mint-burn-growth-watchdog")).runMintBurnGrowthWatchdog(db, options.signal, {
        disabledIds: options.mintBurnDisabledIds,
        disabledSymbols: options.mintBurnDisabledSymbols,
      }),
    },
    {
      source: "duration",
      run: async () => (await import("./cron-duration-watchdog")).runCronDurationWatchdog(db, options.signal),
    },
    {
      source: "repair-debt",
      run: async () => (await import("../lib/repair-tasks")).runWorkerRepairTaskRunner(db, {
        nowSec: options.nowSec,
        signal: options.signal,
        enabled: options.repairRunnerEnabled,
      }),
    },
  ] satisfies Parameters<typeof runCronSentinelSources>[2];
}

export async function runDailyCronSentinel(db: D1Database, options: DailyCronSentinelOptions) {
  return runCronSentinelSources(db, "daily", getDailyCronSentinelSources(db, options), options.nowSec, options.signal);
}
