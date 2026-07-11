import { buildInClause } from "./db";
import { CACHE_FRESHNESS_THRESHOLDS } from "./constants";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "./dex-liquidity";
import {
  FRESHNESS_RATIOS,
  STATUS_CACHE_RATIO_THRESHOLDS,
  classifyFreshnessRatio,
  type FreshnessStatus,
} from "@shared/lib/status-thresholds";
import { getCacheFreshnessLane } from "@shared/lib/api-freshness";
import type { CacheStatus } from "@shared/types/status";
import { buildFxCacheStatus, getFxRatesMetaKey, hydrateFxRateState } from "./fx-rate-state";
import {
  FRESHNESS_SENTINEL_CONFIGS,
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
  listFreshnessSentinelCacheKeys,
  type FreshnessSentinelBackedCacheKey,
  type FreshnessSentinelValidationReason,
  validateFreshnessSentinelPayload,
} from "./freshness-sentinels";
import { toErrorMessage } from "./error-utils";
import { readDewsPublishedGenerationResult } from "./dews-publication-pointer";

export type { CacheStatus };
export type { FreshnessStatus };

export interface CacheStatusFailure {
  key: string;
  source: "cache-table" | "table-freshness" | "cron-fallback";
  message: string;
}

export interface CacheFreshnessDiagnostic {
  key: string;
  freshnessSource: "freshness-sentinel" | "table-fallback" | "cron-fallback";
  warning?: string;
  failureSource?: CacheStatusFailure["source"];
  sentinelValidationReason?: FreshnessSentinelValidationReason;
}

export interface FreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: FreshnessStatus;
}

export type CronTimestampLookupStatus = "ok" | "missing" | "lookup_failed";

export interface CronTimestampLookupResult {
  timestamp: number | null;
  status: CronTimestampLookupStatus;
}

interface CacheRow {
  key: string;
  updated_at: number;
  value?: string | null;
}

interface SentinelBackedFreshnessResult {
  ageSeconds: number | null;
  freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null;
  sentinelValidationReason?: FreshnessSentinelValidationReason;
  diagnostics: CacheFreshnessDiagnostic[];
  failures: CacheStatusFailure[];
  warnings: string[];
}

const SENTINEL_BACKED_CACHE_KEYS = Object.keys(FRESHNESS_SENTINEL_CONFIGS) as FreshnessSentinelBackedCacheKey[];
const SENTINEL_BACKED_CACHE_KEY_SET = new Set<string>(SENTINEL_BACKED_CACHE_KEYS);

const TABLE_FRESHNESS_FALLBACK_QUERIES: Partial<Record<FreshnessSentinelBackedCacheKey, string>> = {
  "dex-liquidity": `SELECT (? - MAX(updated_at)) as age
    FROM dex_liquidity
    WHERE liquidity_score > 0
      AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
  "yield-data": "SELECT (? - MAX(updated_at)) as age FROM yield_data WHERE is_best = 1 AND (publication_generation_id IS NULL OR publication_state = 'published')",
};

export function buildFreshnessMeta(updatedAt: number, maxAgeSec: number): FreshnessMeta {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  return {
    updatedAt,
    ageSeconds: age,
    status: classifyFreshnessRatio(age / maxAgeSec),
  };
}

function buildFallbackWarning(
  key: string,
  source: CacheFreshnessDiagnostic["freshnessSource"],
  failureSource: CacheStatusFailure["source"],
): string {
  if (failureSource === "cache-table" && source === "table-fallback") {
    return `${key}: freshness sentinel lookup failed; using table fallback`;
  }
  if (failureSource === "cache-table" && source === "cron-fallback") {
    return `${key}: freshness sentinel lookup failed; using cron fallback`;
  }
  if (failureSource === "table-freshness" && source === "cron-fallback") {
    return `${key}: freshness table query failed; using cron fallback`;
  }
  if (failureSource === "cron-fallback") {
    return `${key}: freshness fallback lookup failed`;
  }
  return `${key}: freshness diagnostics degraded; using ${source}`;
}

function buildSentinelValidationWarning(
  key: string,
  source: CacheFreshnessDiagnostic["freshnessSource"],
  reason: FreshnessSentinelValidationReason,
): string {
  return `${key}: freshness sentinel invalid (${reason}); using ${source}`;
}

async function loadProducerCronFallbacks(
  db: D1Database,
): Promise<{
  timestampsByKey: Map<FreshnessSentinelBackedCacheKey, number>;
  errorMessage: string | null;
}> {
  const producerJobs = [...new Set(SENTINEL_BACKED_CACHE_KEYS.map((key) => getFreshnessSentinelProducerJob(key)))];
  if (producerJobs.length === 0) {
    return {
      timestampsByKey: new Map(),
      errorMessage: null,
    };
  }

  try {
    const inClause = buildInClause(producerJobs);
    const rows = await db
      .prepare(
        `SELECT job, MAX(started_at) as started_at
         FROM cron_runs
         WHERE status = 'ok' AND job IN (${inClause.sql})
         GROUP BY job`,
      )
      .bind(...inClause.binds)
      .all<{ job: string; started_at: number | null }>();
    const keyByJob = new Map(
      SENTINEL_BACKED_CACHE_KEYS.map((key) => [getFreshnessSentinelProducerJob(key), key]),
    );
    const timestampsByKey = new Map<FreshnessSentinelBackedCacheKey, number>();
    for (const row of rows.results ?? []) {
      const key = keyByJob.get(row.job);
      if (key && row.started_at != null) {
        timestampsByKey.set(key, row.started_at);
      }
    }
    return {
      timestampsByKey,
      errorMessage: null,
    };
  } catch (error) {
    console.warn("[api-freshness] Failed to read producer cron fallbacks", error);
    return {
      timestampsByKey: new Map(),
      errorMessage: toErrorMessage(error),
    };
  }
}

async function resolveSentinelBackedFreshness(params: {
  db: D1Database;
  key: FreshnessSentinelBackedCacheKey;
  now: number;
  cacheLookupFailed: boolean;
  cacheRowsByKey: Map<string, CacheRow>;
  cronFallbacks: Map<FreshnessSentinelBackedCacheKey, number>;
  cronFallbackError: string | null;
}): Promise<SentinelBackedFreshnessResult> {
  const diagnostics: CacheFreshnessDiagnostic[] = [];
  const failures: CacheStatusFailure[] = [];
  const warnings: string[] = [];

  const sentinelKey = getFreshnessSentinelCacheKey(params.key);
  const sentinelRow = params.cacheRowsByKey.get(sentinelKey);
  const sentinelValidation = sentinelRow
    ? validateFreshnessSentinelPayload({
        value: sentinelRow.value,
        rowUpdatedAt: sentinelRow.updated_at,
        expectedSource: getFreshnessSentinelProducerJob(params.key),
        now: params.now,
      })
    : null;
  if (sentinelValidation?.ok && sentinelValidation.payload) {
    return {
      ageSeconds: Math.max(0, params.now - sentinelValidation.payload.updatedAt),
      freshnessSource: "freshness-sentinel",
      diagnostics,
      failures,
      warnings,
    };
  }

  const sentinelFailureSource: CacheStatusFailure["source"] | null = params.cacheLookupFailed ? "cache-table" : null;

  try {
    let tableAge: number | null;
    if (params.key === "dews") {
      const published = await readDewsPublishedGenerationResult(params.db, params.now);
      if (published.status !== "ok") {
        const detail = published.status === "read-failed"
          ? published.error
          : published.status === "invalid-pointer"
            ? published.reason
            : "publication pointer is missing";
        throw new Error(`DEWS published generation unavailable (${published.status}): ${detail}`);
      }
      tableAge = Math.max(0, params.now - published.computedAt);
    } else {
      const query = TABLE_FRESHNESS_FALLBACK_QUERIES[params.key];
      if (!query) throw new Error(`No table freshness fallback configured for ${params.key}`);
      const row = await params.db
        .prepare(query)
        .bind(params.now)
        .first<{ age: number | null }>();
      tableAge = row?.age != null ? Math.max(0, row.age) : null;
    }
    if (tableAge != null) {
      const warning = sentinelValidation?.reason
        ? buildSentinelValidationWarning(params.key, "table-fallback", sentinelValidation.reason)
        : sentinelFailureSource
          ? buildFallbackWarning(params.key, "table-fallback", sentinelFailureSource)
          : undefined;
      if (warning) {
        warnings.push(warning);
        diagnostics.push({
          key: params.key,
          freshnessSource: "table-fallback",
          warning,
          ...(sentinelFailureSource ? { failureSource: sentinelFailureSource } : {}),
          ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
        });
        console.info(`[api-freshness] ${warning}`);
      } else {
        diagnostics.push({
          key: params.key,
          freshnessSource: "table-fallback",
        });
      }
      return {
        ageSeconds: tableAge,
        freshnessSource: "table-fallback",
        ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
        diagnostics,
        failures,
        warnings,
      };
    }
  } catch (error) {
    failures.push({
      key: params.key,
      source: "table-freshness",
      message: toErrorMessage(error),
    });
    if (params.key === "dews") {
      return {
        ageSeconds: null,
        freshnessSource: null,
        ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
        diagnostics,
        failures,
        warnings,
      };
    }
  }

  const cronFallbackTimestamp = params.cronFallbacks.get(params.key) ?? null;
  if (cronFallbackTimestamp != null) {
    const failureSource = failures[0]?.source ?? sentinelFailureSource ?? undefined;
    const warning = sentinelValidation?.reason
      ? buildSentinelValidationWarning(params.key, "cron-fallback", sentinelValidation.reason)
      : failureSource
        ? buildFallbackWarning(params.key, "cron-fallback", failureSource)
        : undefined;
    if (warning) {
      warnings.push(warning);
      console.info(`[api-freshness] ${warning}`);
    }
    diagnostics.push({
      key: params.key,
      freshnessSource: "cron-fallback",
      ...(warning ? { warning } : {}),
      ...(failureSource ? { failureSource } : {}),
      ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
    });
    return {
      ageSeconds: Math.max(0, params.now - cronFallbackTimestamp),
      freshnessSource: "cron-fallback",
      ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
      diagnostics,
      failures,
      warnings,
    };
  }

  if (params.cronFallbackError) {
    failures.push({
      key: params.key,
      source: "cron-fallback",
      message: params.cronFallbackError,
    });
  }

  return {
    ageSeconds: null,
    freshnessSource: null,
    ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
    diagnostics,
    failures,
    warnings,
  };
}

export async function buildCacheStatuses(
  db: D1Database,
  now: number,
): Promise<{
  caches: Record<string, CacheStatus>;
  worstRatio: number;
  failures: CacheStatusFailure[];
  diagnostics: CacheFreshnessDiagnostic[];
  statusFloor: "healthy" | "degraded" | "stale";
  warnings: string[];
}> {
  const sentinelCacheKeys = listFreshnessSentinelCacheKeys();
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (key) => !SENTINEL_BACKED_CACHE_KEY_SET.has(key),
  );
  const fxMetaKey = getFxRatesMetaKey();
  const cacheLookupKeys = Array.from(
    new Set(
      cacheOnlyKeys.includes("fx-rates")
        ? [...cacheOnlyKeys, ...sentinelCacheKeys, fxMetaKey]
        : [...cacheOnlyKeys, ...sentinelCacheKeys],
    ),
  );
  let cacheRows: { results?: CacheRow[] } = { results: [] };
  const failures: CacheStatusFailure[] = [];

  if (cacheLookupKeys.length > 0) {
    try {
      const inClause = buildInClause(cacheLookupKeys);
      cacheRows = await db
        .prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${inClause.sql})`)
        .bind(...inClause.binds)
        .all<CacheRow>();
    } catch (err) {
      failures.push({
        key: "__cache__",
        source: "cache-table",
        message: toErrorMessage(err),
      });
      cacheRows = { results: [] };
    }
  }

  const cacheLookupFailed = failures.some((failure) => failure.key === "__cache__");
  const cacheRowsByKey = new Map((cacheRows.results ?? []).map((row) => [row.key, row]));
  const cacheUpdatedAtByKey = new Map((cacheRows.results ?? []).map((row) => [row.key, row.updated_at]));
  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;
  let statusFloor: "healthy" | "degraded" | "stale" = "healthy";
  const warnings: string[] = [];
  const diagnostics: CacheFreshnessDiagnostic[] = [];
  const freshnessSourceByKey = new Map<string, CacheFreshnessDiagnostic["freshnessSource"]>();
  const sentinelValidationReasonByKey = new Map<string, FreshnessSentinelValidationReason>();
  const fxState = cacheOnlyKeys.includes("fx-rates")
    ? hydrateFxRateState(
        (() => {
          const row = cacheRowsByKey.get("fx-rates");
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
        (() => {
          const row = cacheRowsByKey.get(fxMetaKey);
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
      )
    : null;
  const cronFallbackLookup = await loadProducerCronFallbacks(db);

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
    } else if (SENTINEL_BACKED_CACHE_KEY_SET.has(key)) {
      const freshness = await resolveSentinelBackedFreshness({
        db,
        key: key as FreshnessSentinelBackedCacheKey,
        now,
        cacheLookupFailed,
        cacheRowsByKey,
        cronFallbacks: cronFallbackLookup.timestampsByKey,
        cronFallbackError: cronFallbackLookup.errorMessage,
      });
      ageSeconds = freshness.ageSeconds;
      if (freshness.freshnessSource) {
        freshnessSourceByKey.set(key, freshness.freshnessSource);
      }
      if (freshness.sentinelValidationReason) {
        sentinelValidationReasonByKey.set(key, freshness.sentinelValidationReason);
      }
      failures.push(...freshness.failures);
      warnings.push(...freshness.warnings);
      diagnostics.push(...freshness.diagnostics);
    } else {
      const updatedAt = cacheUpdatedAtByKey.get(key);
      ageSeconds = updatedAt != null ? now - updatedAt : null;
    }

    const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
    if (ratio > worstRatio) worstRatio = ratio;
    if (!caches[key]) {
      const diagnostic = diagnostics.find((entry) => entry.key === key);
      caches[key] = {
        ageSeconds,
        maxAge,
        healthy: ratio <= FRESHNESS_RATIOS.DEGRADED,
        ...(freshnessSourceByKey.has(key) ? { freshnessSource: freshnessSourceByKey.get(key) } : {}),
        ...(sentinelValidationReasonByKey.has(key)
          ? { sentinelValidationReason: sentinelValidationReasonByKey.get(key) }
          : {}),
        ...(diagnostic?.warning ? { warning: diagnostic.warning } : {}),
      };
    }
  }

  if (statusFloor !== "stale") {
    statusFloor =
      worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale
        ? "stale"
        : worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded
          ? "degraded"
      : statusFloor;
  }

  for (const [key, cache] of Object.entries(caches)) {
    const lane = getCacheFreshnessLane(key);
    if (!lane) continue;
    caches[key] = {
      ...cache,
      producerJob: lane.producerJob,
      producerIntervalSec: lane.producerIntervalSec,
      endpointMaxAge: lane.endpointMaxAgeSec,
      availabilityMaxAge: lane.availabilityMaxAgeSec,
      endpointBudgetReason: lane.endpointBudgetReason,
      availabilityBudgetReason: lane.availabilityBudgetReason,
    };
  }

  return { caches, worstRatio, failures, diagnostics, statusFloor, warnings };
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
