import { buildInClause } from "./db";
import { CACHE_FRESHNESS_THRESHOLDS } from "./constants";
import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CacheStatus } from "@shared/types/status";
import { buildFxCacheStatus, getFxRatesMetaKey, hydrateFxRateState } from "./fx-rate-state";

export type { CacheStatus };

export interface CacheStatusFailure {
  key: string;
  source: "cache-table" | "table-freshness";
  message: string;
}

export interface FreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: "fresh" | "degraded" | "stale";
}

export type CronTimestampLookupStatus = "ok" | "missing" | "lookup_failed";

export interface CronTimestampLookupResult {
  timestamp: number | null;
  status: CronTimestampLookupStatus;
}

export function buildFreshnessMeta(updatedAt: number, maxAgeSec: number): FreshnessMeta {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const ratio = age / maxAgeSec;
  return {
    updatedAt,
    ageSeconds: age,
    status: ratio <= FRESHNESS_RATIOS.FRESH ? "fresh" : ratio <= FRESHNESS_RATIOS.DEGRADED ? "degraded" : "stale",
  };
}

const TABLE_FRESHNESS_QUERIES: Record<string, string> = {
  "dex-liquidity": "SELECT (? - MAX(updated_at)) as age FROM dex_liquidity WHERE liquidity_score > 0",
  "yield-data": "SELECT (? - MAX(updated_at)) as age FROM yield_data WHERE is_best = 1",
  "dews": "SELECT (? - MAX(computed_at)) as age FROM stress_signals",
};

export async function buildCacheStatuses(
  db: D1Database,
  now: number,
): Promise<{
  caches: Record<string, CacheStatus>;
  worstRatio: number;
  failures: CacheStatusFailure[];
  statusFloor: "healthy" | "degraded" | "stale";
  warnings: string[];
}> {
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (key) => !(key in TABLE_FRESHNESS_QUERIES),
  );
  const fxMetaKey = getFxRatesMetaKey();
  const cacheLookupKeys = cacheOnlyKeys.includes("fx-rates")
    ? [...cacheOnlyKeys, fxMetaKey]
    : cacheOnlyKeys;
  let cacheRows: { results?: Array<{ key: string; updated_at: number; value?: string | null }> } = { results: [] };
  const failures: CacheStatusFailure[] = [];

  if (cacheLookupKeys.length > 0) {
    try {
      const inClause = buildInClause(cacheLookupKeys);
      cacheRows = await db
        .prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${inClause.sql})`)
        .bind(...inClause.binds)
        .all<{ key: string; updated_at: number; value?: string | null }>();
    } catch (err) {
      failures.push({
        key: "__cache__",
        source: "cache-table",
        message: err instanceof Error ? err.message : String(err),
      });
      cacheRows = { results: [] };
    }
  }

  const cacheMap = new Map((cacheRows.results ?? []).map((row) => [row.key, row.updated_at]));
  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;
  let statusFloor: "healthy" | "degraded" | "stale" = "healthy";
  const warnings: string[] = [];
  const fxState = cacheOnlyKeys.includes("fx-rates")
    ? hydrateFxRateState(
        (() => {
          const row = (cacheRows.results ?? []).find((entry) => entry.key === "fx-rates");
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
        (() => {
          const row = (cacheRows.results ?? []).find((entry) => entry.key === fxMetaKey);
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
      )
    : null;

  for (const [key, maxAge] of Object.entries(CACHE_FRESHNESS_THRESHOLDS)) {
    let ageSeconds: number | null;

    if (key === "fx-rates") {
      const fx = buildFxCacheStatus(fxState, maxAge, now);
      caches[key] = fx.cacheStatus;
      ageSeconds = fx.cacheStatus.ageSeconds;
      if (fx.warning) warnings.push(`fx-rates: ${fx.warning}`);
      if (fx.statusFloor === "stale") {
        statusFloor = "stale";
      } else if (fx.statusFloor === "degraded" && statusFloor === "healthy") {
        statusFloor = "degraded";
      }
    } else if (key in TABLE_FRESHNESS_QUERIES) {
      try {
        const row = await db
          .prepare(TABLE_FRESHNESS_QUERIES[key])
          .bind(now)
          .first<{ age: number | null }>();
        ageSeconds = row?.age != null ? Math.max(0, row.age) : null;
      } catch (err) {
        failures.push({
          key,
          source: "table-freshness",
          message: err instanceof Error ? err.message : String(err),
        });
        ageSeconds = null;
      }
    } else {
      const updatedAt = cacheMap.get(key);
      ageSeconds = updatedAt != null ? now - updatedAt : null;
    }

    const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
    if (ratio > worstRatio) worstRatio = ratio;
    if (!caches[key]) {
      caches[key] = { ageSeconds, maxAge, healthy: ratio <= FRESHNESS_RATIOS.DEGRADED };
    }
  }

  if (statusFloor !== "stale") {
    statusFloor =
      worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale
        ? "stale"
        : worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded
          ? "degraded"
          : statusFloor;
  } else if (worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
    statusFloor = "stale";
  }

  return { caches, worstRatio, failures, statusFloor, warnings };
}

export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
): Record<string, string> {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (age > FRESHNESS_RATIOS.FRESH * maxAgeSec) {
    result.Warning = `110 - "Response is stale (${age}s old, max ${maxAgeSec}s)"`;
    result["Cache-Control"] = "no-store";
  }
  return result;
}

export async function getLatestSuccessfulCronTimestamp(
  db: D1Database,
  job: string,
  fallback: number,
): Promise<number> {
  const result = await getLatestSuccessfulCronTimestampResult(db, job);
  return result.timestamp ?? fallback;
}

export async function getLatestSuccessfulCronTimestampResult(
  db: D1Database,
  job: string,
): Promise<CronTimestampLookupResult> {
  try {
    const row = await db
      .prepare("SELECT MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'")
      .bind(job)
      .first<{ started_at: number | null }>();
    if (row?.started_at != null) {
      return {
        timestamp: row.started_at,
        status: "ok",
      };
    }
    return {
      timestamp: null,
      status: "missing",
    };
  } catch (error) {
    console.warn(`[api-freshness] Failed to read latest successful cron timestamp for ${job}`, error);
    return {
      timestamp: null,
      status: "lookup_failed",
    };
  }
}
