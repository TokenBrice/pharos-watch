import type { CronResult } from "../lib/cron-logger";
import { CRON_SENTINEL_RULES, type CronSentinelRuleSource } from "./cron-sentinel-rules";
import type { CronSentinelMode } from "./cron-sentinel";

export interface CronSentinelSourceResult {
  source: CronSentinelRuleSource;
  result: CronResult;
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

export function buildCronSentinelResult(
  mode: CronSentinelMode,
  sourceResults: readonly CronSentinelSourceResult[],
): CronResult {
  const results = sourceResults.map(({ result }) => result);
  const activeSources = SOURCES_BY_MODE[mode];
  return {
    status: worstStatus(results),
    itemCount: results.reduce((sum, result) => sum + (result.itemCount ?? 0), 0),
    metadata: JSON.stringify({
      mode,
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
