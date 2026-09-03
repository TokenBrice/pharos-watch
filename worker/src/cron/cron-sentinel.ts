import type { TelegramCreds } from "../lib/telegram";
import type { CronResult } from "../lib/cron-logger";
import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";
import { runCronStalenessWatchdog } from "./cron-staleness-watchdog";
import { runDigestPublicationWatchdog } from "./digest-publication-watchdog";
import { runCronDurationWatchdog } from "./cron-duration-watchdog";
import { runDexExitRouteTurnoverWatchdog } from "./dex-exit-route-turnover-watchdog";
import { runMintBurnGrowthWatchdog } from "./mint-burn-growth-watchdog";
import { runReservePostSyncWatchdog } from "./reserve-post-sync-watchdog";
import { CRON_SENTINEL_RULES, type CronSentinelRuleSource } from "./cron-sentinel-rules";

export type CronSentinelMode = "status" | "daily" | "turnover" | "reserve-post-sync";

export interface CronSentinelOptions {
  mode: CronSentinelMode;
  nowSec?: number;
  operatorTelegramCreds?: TelegramCreds | null;
  repairRunnerEnabled?: boolean;
  signal?: AbortSignal;
}

const SOURCES_BY_MODE: Record<CronSentinelMode, readonly CronSentinelRuleSource[]> = {
  status: ["freshness", "digest-publication"],
  daily: ["growth", "duration", "repair-debt"],
  turnover: ["turnover"],
  "reserve-post-sync": ["reserve-post-sync"],
};

function parseMetadata(metadata: string | undefined): unknown {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata) as unknown;
  } catch {
    return metadata;
  }
}

function worstStatus(results: readonly CronResult[]): CronResult["status"] {
  if (results.some((result) => result.status === "error")) return "error";
  if (results.some((result) => result.status === "degraded")) return "degraded";
  if (results.length > 0 && results.every((result) => result.status === "skipped_neutral")) {
    return "skipped_neutral";
  }
  return "ok";
}

export async function runCronSentinel(
  db: D1Database,
  options: CronSentinelOptions,
): Promise<CronResult> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1_000);
  const sourceResults: Array<{ source: CronSentinelRuleSource; result: CronResult }> = [];
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

  const results = sourceResults.map(({ result }) => result);
  const activeSources = SOURCES_BY_MODE[options.mode];
  return {
    status: worstStatus(results),
    itemCount: results.reduce((sum, result) => sum + (result.itemCount ?? 0), 0),
    metadata: JSON.stringify({
      mode: options.mode,
      rules: CRON_SENTINEL_RULES.filter((rule) => activeSources.includes(rule.source)),
      sources: Object.fromEntries(sourceResults.map(({ source, result }) => [source, {
        status: result.status ?? "ok",
        itemCount: result.itemCount ?? 0,
        metadata: parseMetadata(result.metadata),
        ...(result.error ? { error: result.error } : {}),
      }])),
    }),
  };
}
