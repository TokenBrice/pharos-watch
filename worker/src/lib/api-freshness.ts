import { logWorkerEventArgs } from "./structured-log";
import { buildInClause } from "./db";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "./dex-liquidity";
import {
  STATUS_CACHE_RATIO_OVERRIDES,
  STATUS_CACHE_RATIO_THRESHOLDS,
  classifyFreshnessRatio,
  getCacheHealthyMaxRatio,
  type FreshnessStatus,
} from "@shared/lib/status-thresholds";
import {
  CACHE_AVAILABILITY_MAX_AGE_SEC as CACHE_FRESHNESS_THRESHOLDS,
  getCacheFreshnessLane,
} from "@shared/lib/api-freshness";
import type { ApiMeta } from "@shared/types/api-meta";
import type { CacheStatus } from "@shared/types/status";
import { buildFxCacheStatus, getFxRatesMetaKey, hydrateFxRateState } from "./fx-rate-state";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
  listFreshnessSentinelBackedCacheKeys,
  listFreshnessSentinelCacheKeys,
  type FreshnessSentinelBackedCacheKey,
  type FreshnessSentinelValidationReason,
  validateFreshnessSentinelPayload,
} from "./freshness-sentinels";
import { toErrorMessage } from "@shared/lib/error-utils";
import { readDewsPublishedGenerationResult } from "./dews-publication-pointer";
import {
  API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  measureFreshnessAge,
} from "./api-freshness-age";

export { addFreshnessHeaders } from "./api-freshness-headers";

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

/**
 * Input quality for the generation a freshness verdict describes (rule R3). A
 * sentinel records *which* generation is served; this records whether the run
 * that produced it had clean inputs, so a fresh timestamp can no longer imply
 * a clean publication. `degraded: null` means the quality evidence itself
 * could not be read — unknown, never clean (rule R2).
 */
export interface CacheQualityVerdict {
  degraded: boolean | null;
  reason: string | null;
  /** Producer runs that degraded/errored since its last clean run; `null` when unreadable (rule R1). */
  streakDegradedRuns: number | null;
}

export type FreshnessMeta = Pick<ApiMeta, "updatedAt" | "ageSeconds" | "status">;

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

interface ProducerCronObservation {
  lastOkStartedAt: number | null;
  degradedRunsSinceOk: number | null;
}

interface ProducerCronHistoryRead {
  value: Map<FreshnessSentinelBackedCacheKey, ProducerCronObservation> | null;
  error: string | null;
}

interface SentinelBackedFreshnessResult {
  ageSeconds: number | null;
  freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null;
  sentinelValidationReason?: FreshnessSentinelValidationReason;
  quality: CacheQualityVerdict;
  diagnostics: CacheFreshnessDiagnostic[];
  failures: CacheStatusFailure[];
  warnings: string[];
}


const TABLE_FRESHNESS_FALLBACK_QUERIES: Partial<Record<FreshnessSentinelBackedCacheKey, string>> = {
  "dex-liquidity": `SELECT (? - MAX(updated_at)) as age
    FROM dex_liquidity
    WHERE liquidity_score > 0
      AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
  "yield-data": "SELECT (? - MAX(updated_at)) as age FROM yield_data WHERE is_best = 1 AND (publication_generation_id IS NULL OR publication_state = 'published')",
};

export function buildFreshnessMeta(updatedAt: number, maxAgeSec: number): FreshnessMeta {
  const { ageSeconds, futureSkewSeconds } = measureFreshnessAge(
    Date.now() / 1000,
    updatedAt,
    API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  );
  return {
    updatedAt,
    ageSeconds,
    status: futureSkewSeconds > API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC
      ? "degraded"
      : classifyFreshnessRatio(ageSeconds / maxAgeSec),
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

/**
 * Single per-request producer-history read behind a typed `{value, error}`
 * boundary (rule R2): it carries both the cron fallback timestamp and the
 * consecutive-degraded-run streak used as the lane's quality input. A failed
 * read yields `value: null` so callers publish "unknown", never zero.
 */
async function readProducerCronHistory(
  db: D1Database,
  sentinelBackedCacheKeys: readonly FreshnessSentinelBackedCacheKey[],
): Promise<ProducerCronHistoryRead> {
  const producerJobs = [...new Set(sentinelBackedCacheKeys.map((key) => getFreshnessSentinelProducerJob(key)))];
  if (producerJobs.length === 0) {
    return { value: new Map(), error: null };
  }

  try {
    const inClause = buildInClause(producerJobs);
    const rows = await db
      .prepare(
        `SELECT job,
                MAX(CASE WHEN status = 'ok' THEN started_at END) as started_at,
                SUM(CASE
                      WHEN status IN ('degraded', 'error')
                        AND started_at > COALESCE((
                          SELECT MAX(clean_run.started_at) FROM cron_runs clean_run
                          WHERE clean_run.job = cron_runs.job AND clean_run.status = 'ok'), 0)
                      THEN 1 ELSE 0 END) as degraded_runs_since_ok
         FROM cron_runs
         WHERE job IN (${inClause.sql})
         GROUP BY job`,
      )
      .bind(...inClause.binds)
      .all<{ job: string; started_at: number | null; degraded_runs_since_ok: number | null }>();
    const keyByJob = new Map(
      sentinelBackedCacheKeys.map((key) => [getFreshnessSentinelProducerJob(key), key]),
    );
    const value = new Map<FreshnessSentinelBackedCacheKey, ProducerCronObservation>();
    for (const row of rows.results ?? []) {
      const key = keyByJob.get(row.job);
      if (!key) continue;
      value.set(key, {
        lastOkStartedAt: row.started_at ?? null,
        degradedRunsSinceOk: row.degraded_runs_since_ok ?? null,
      });
    }
    return { value, error: null };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[api-freshness] Failed to read producer cron fallbacks", error);
    return { value: null, error: toErrorMessage(error) };
  }
}

function buildCacheQuality(params: {
  freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null;
  sentinelValidationReason: FreshnessSentinelValidationReason | undefined;
  cacheLookupFailed: boolean;
  observation: ProducerCronObservation | undefined;
  historyReadFailed: boolean;
}): CacheQualityVerdict {
  const streakDegradedRuns = params.historyReadFailed
    ? null
    : params.observation?.degradedRunsSinceOk ?? null;
  if (params.freshnessSource !== "freshness-sentinel") {
    // Table and cron fallbacks measure row writes and run clocks, not the
    // generation that was published, so they cannot attest input quality.
    return {
      degraded: true,
      reason: params.sentinelValidationReason
        ? `freshness-sentinel-invalid:${params.sentinelValidationReason}`
        : params.cacheLookupFailed
          ? "freshness-sentinel-unreadable"
          : "freshness-sentinel-missing",
      streakDegradedRuns,
    };
  }
  if (params.historyReadFailed) {
    // The quality evidence itself is unreadable: publish unknown with a
    // machine-readable reason instead of letting a valid sentinel launder the
    // failed read into a clean verdict (rules R2/R4).
    return { degraded: null, reason: "producer-history-unreadable", streakDegradedRuns: null };
  }
  if (streakDegradedRuns != null && streakDegradedRuns > 0) {
    return { degraded: true, reason: "producer-degraded-since-last-clean-run", streakDegradedRuns };
  }
  return { degraded: false, reason: null, streakDegradedRuns };
}

async function resolveSentinelBackedFreshness(params: {
  db: D1Database;
  key: FreshnessSentinelBackedCacheKey;
  now: number;
  cacheLookupFailed: boolean;
  cacheRowsByKey: Map<string, CacheRow>;
  cronHistory: ProducerCronHistoryRead;
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

  const freshnessOutcome = (
    ageSeconds: number | null,
    freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null,
  ): SentinelBackedFreshnessResult => ({
    ageSeconds,
    freshnessSource,
    ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
    quality: buildCacheQuality({
      freshnessSource,
      sentinelValidationReason: sentinelValidation?.reason,
      cacheLookupFailed: params.cacheLookupFailed,
      observation: params.cronHistory.value?.get(params.key),
      historyReadFailed: params.cronHistory.value == null,
    }),
    diagnostics,
    failures,
    warnings,
  });

  const recordFreshnessOutcome = (
    source: NonNullable<CacheFreshnessDiagnostic["freshnessSource"]>,
    failureSource: CacheStatusFailure["source"] | undefined,
    validation: FreshnessSentinelValidationReason | undefined,
  ): void => {
    const warning = validation
      ? buildSentinelValidationWarning(params.key, source, validation)
      : failureSource
        ? buildFallbackWarning(params.key, source, failureSource)
        : undefined;
    if (warning) {
      warnings.push(warning);
      logWorkerEventArgs("lib", "info", `[api-freshness] ${warning}`);
    }
    diagnostics.push({
      key: params.key,
      freshnessSource: source,
      ...(warning ? { warning } : {}),
      ...(failureSource ? { failureSource } : {}),
      ...(validation ? { sentinelValidationReason: validation } : {}),
    });
  };

  if (sentinelValidation?.ok && sentinelValidation.payload) {
    return freshnessOutcome(Math.max(0, params.now - sentinelValidation.payload.updatedAt), "freshness-sentinel");
  }

  const sentinelFailureSource = params.cacheLookupFailed ? "cache-table" as const : undefined;

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
      recordFreshnessOutcome("table-fallback", sentinelFailureSource, sentinelValidation?.reason);
      return freshnessOutcome(tableAge, "table-fallback");
    }
  } catch (error) {
    failures.push({
      key: params.key,
      source: "table-freshness",
      message: toErrorMessage(error),
    });
    if (params.key === "dews") {
      return freshnessOutcome(null, null);
    }
  }

  const cronFallbackTimestamp = params.cronHistory.value?.get(params.key)?.lastOkStartedAt ?? null;
  if (cronFallbackTimestamp != null) {
    recordFreshnessOutcome(
      "cron-fallback",
      failures[0]?.source ?? sentinelFailureSource,
      sentinelValidation?.reason,
    );
    return freshnessOutcome(Math.max(0, params.now - cronFallbackTimestamp), "cron-fallback");
  }

  if (params.cronHistory.error) {
    failures.push({
      key: params.key,
      source: "cron-fallback",
      message: params.cronHistory.error,
    });
  }

  return freshnessOutcome(null, null);
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
  const sentinelBackedCacheKeys = listFreshnessSentinelBackedCacheKeys();
  const sentinelBackedCacheKeySet = new Set<string>(sentinelBackedCacheKeys);
  const sentinelCacheKeys = listFreshnessSentinelCacheKeys();
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (key) => !sentinelBackedCacheKeySet.has(key),
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
  const qualityByKey = new Map<string, CacheQualityVerdict>();
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
  const cronHistory = await readProducerCronHistory(db, sentinelBackedCacheKeys);

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
    } else if (sentinelBackedCacheKeySet.has(key)) {
      const freshness = await resolveSentinelBackedFreshness({
        db,
        key: key as FreshnessSentinelBackedCacheKey,
        now,
        cacheLookupFailed,
        cacheRowsByKey,
        cronHistory,
      });
      ageSeconds = freshness.ageSeconds;
      if (freshness.freshnessSource) {
        freshnessSourceByKey.set(key, freshness.freshnessSource);
      }
      if (freshness.sentinelValidationReason) {
        sentinelValidationReasonByKey.set(key, freshness.sentinelValidationReason);
      }
      qualityByKey.set(key, freshness.quality);
      failures.push(...freshness.failures);
      warnings.push(...freshness.warnings);
      diagnostics.push(...freshness.diagnostics);
    } else {
      const updatedAt = cacheUpdatedAtByKey.get(key);
      ageSeconds = updatedAt != null ? now - updatedAt : null;
    }

    const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
    if (ratio > worstRatio) worstRatio = ratio;
    // Per-cache availability override (e.g. yield-data) uses tighter bands than
    // the global worstRatio comparison below, so escalate the floor here where
    // the cache key is in scope. Escalation-only; never downgrades.
    const ratioOverride = STATUS_CACHE_RATIO_OVERRIDES[key];
    if (ratioOverride && statusFloor !== "stale") {
      if (ratio > ratioOverride.stale) {
        statusFloor = "stale";
      } else if (ratio > ratioOverride.degraded && statusFloor === "healthy") {
        statusFloor = "degraded";
      }
    }
    const healthyMaxRatio = getCacheHealthyMaxRatio(key);
    if (!caches[key]) {
      const diagnostic = diagnostics.find((entry) => entry.key === key);
      const quality = qualityByKey.get(key);
      caches[key] = {
        ageSeconds,
        maxAge,
        healthyMaxRatio,
        healthyMaxAge: maxAge * healthyMaxRatio,
        // Unknown quality (degraded === null) fails closed: a lane is healthy
        // only when its quality verdict is explicitly clean (rule R2).
        healthy: ratio <= healthyMaxRatio && (quality == null || quality.degraded === false),
        ...(qualityByKey.has(key)
          ? {
              degraded: quality?.degraded,
              degradedReason: quality?.reason,
              streakDegradedRuns: quality?.streakDegradedRuns,
            }
          : {}),
        ...(freshnessSourceByKey.has(key) ? { freshnessSource: freshnessSourceByKey.get(key) } : {}),
        ...(sentinelValidationReasonByKey.has(key)
          ? { sentinelValidationReason: sentinelValidationReasonByKey.get(key) }
          : {}),
        ...(diagnostic?.warning ? { warning: diagnostic.warning } : {}),
      };
    } else {
      // fx-rates publishes a bespoke status object; it still states the band its verdict used.
      caches[key] = { ...caches[key], healthyMaxRatio, healthyMaxAge: maxAge * healthyMaxRatio };
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
    logWorkerEventArgs("lib", "warn", `[api-freshness] Failed to read latest successful cron timestamp for ${job}`, error);
    return {
      timestamp: null,
      status: "lookup_failed",
    };
  }
}
