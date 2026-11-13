import { logWorkerEventArgs } from "../structured-log";
import { buildInClause } from "../db";
import { DEX_LIQUIDITY_SERVED_GENERATION_SQL, readDexLiquidityFreshnessAge } from "../dex-liquidity";
import { YIELD_SERVED_GENERATION_SQL, readYieldFreshnessAge } from "../yield-rankings-coin-cache";
import {
  STATUS_CACHE_RATIO_OVERRIDES,
  STATUS_CACHE_RATIO_THRESHOLDS,
  getCacheHealthyMaxRatio,
} from "@shared/lib/status-thresholds";
import {
  CACHE_AVAILABILITY_MAX_AGE_SEC as CACHE_FRESHNESS_THRESHOLDS,
  getCacheFreshnessLane,
} from "@shared/lib/api-freshness";
import type { CacheStatus } from "@shared/types/status";
import { buildFxCacheStatus, getFxRatesMetaKey, hydrateFxRateStateFromCacheRows } from "../fx-rate-state";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
  listFreshnessSentinelBackedCacheKeys,
  listFreshnessSentinelCacheKeys,
  type FreshnessSentinelBackedCacheKey,
  type FreshnessSentinelValidationReason,
  validateFreshnessSentinelPayload,
} from "../freshness-sentinels";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  DEWS_PUBLICATION_POINTER_CACHE_KEY,
  DEWS_SERVED_GENERATION_SQL,
  DewsPublicationPointerReadError,
  readDewsFreshnessAge,
} from "../dews-publication-pointer";
import { CONFIRMED_CRON_OUTPUT_AT_SQL } from "../cron-output";
import { assessFreshnessTimestamp, type FreshnessTimestampReason } from "../api-freshness-age";

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
  /** Degraded publications since the last clean publication; `null` when unreadable (rule R1). */
  streakDegradedRuns: number | null;
}

interface CacheRow {
  key: string;
  updated_at: number;
  value?: string | null;
  observed_at?: number;
  served_generation_id?: string | null;
}

interface ProducerCronObservation {
  lastPublishedAt: number | null;
  lastPublishedGenerationId: string | null;
  degradedRunsSinceOk: number | null;
  latestReason: string | null;
}

interface ProducerCronHistoryRead {
  value: Map<FreshnessSentinelBackedCacheKey, ProducerCronObservation> | null;
  error: string | null;
}

interface SentinelBackedFreshnessResult {
  ageSeconds: number | null;
  generationId: string | null;
  publishedAt: number | null;
  timestampReason: FreshnessTimestampReason | null;
  freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null;
  sentinelValidationReason?: FreshnessSentinelValidationReason;
  quality: CacheQualityVerdict;
  diagnostics: CacheFreshnessDiagnostic[];
  failures: CacheStatusFailure[];
  warnings: string[];
}


const TABLE_FRESHNESS_READERS: Partial<Record<FreshnessSentinelBackedCacheKey,
  (db: D1Database, now: number, readClock: number) => Promise<number | null>
>> = {
  "dex-liquidity": readDexLiquidityFreshnessAge,
  "yield-data": readYieldFreshnessAge,
  dews: readDewsFreshnessAge,
};

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
 * consecutive-degraded-publication streak used as the lane's quality input. A failed
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
        // Materialized once: the aggregate references this row set four times,
        // and an inlined CTE re-parsed each run's metadata on every reference.
        `WITH producer_runs AS MATERIALIZED (
           SELECT job, started_at, status, degraded_reason, ${CONFIRMED_CRON_OUTPUT_AT_SQL} AS output_at,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.persistence.generationId') END AS generation_id,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.quality.degraded') ELSE 0 END AS quality_degraded,
                  CASE WHEN json_valid(metadata) THEN
                    COALESCE(json_extract(metadata, '$.quality.reasons[0]'), json_extract(metadata, '$.quality.reason'))
                  END AS quality_reason
           FROM cron_runs WHERE job IN (${inClause.sql})
         )
         SELECT job,
                MAX(output_at) as started_at,
                (SELECT recent.generation_id FROM producer_runs recent
                 WHERE recent.job = producer_runs.job AND recent.output_at IS NOT NULL
                 ORDER BY recent.output_at DESC, recent.started_at DESC LIMIT 1) as generation_id,
                SUM(CASE
                      WHEN output_at IS NOT NULL AND (status = 'degraded' OR quality_degraded = 1)
                        AND output_at > COALESCE((
                          SELECT MAX(clean_run.output_at) FROM producer_runs clean_run
                          WHERE clean_run.job = producer_runs.job AND clean_run.status = 'ok'
                            AND clean_run.output_at IS NOT NULL
                            AND COALESCE(clean_run.quality_degraded, 0) != 1), 0)
                      THEN 1 ELSE 0 END) as degraded_runs_since_ok,
                /* A degraded run names its own cause; advisory quality flags come second. */
                (SELECT CASE WHEN recent.status = 'degraded'
                          THEN COALESCE(recent.degraded_reason, recent.quality_reason)
                          ELSE COALESCE(recent.quality_reason, recent.degraded_reason) END
                 FROM producer_runs recent
                 WHERE recent.job = producer_runs.job
                   AND recent.output_at IS NOT NULL
                   AND (recent.status = 'degraded' OR recent.quality_degraded = 1)
                 ORDER BY recent.output_at DESC, recent.started_at DESC LIMIT 1) as latest_reason
         FROM producer_runs
         GROUP BY job`,
      )
      .bind(...inClause.binds)
      .all<{ job: string; started_at: number | null; generation_id: string | null; degraded_runs_since_ok: number | null; latest_reason: string | null }>();
    const keyByJob = new Map(
      sentinelBackedCacheKeys.map((key) => [getFreshnessSentinelProducerJob(key), key]),
    );
    const value = new Map<FreshnessSentinelBackedCacheKey, ProducerCronObservation>();
    for (const row of rows.results ?? []) {
      const key = keyByJob.get(row.job);
      if (!key) continue;
      value.set(key, {
        lastPublishedAt: row.started_at ?? null,
        lastPublishedGenerationId: row.generation_id ?? null,
        degradedRunsSinceOk: row.degraded_runs_since_ok ?? null,
        latestReason: row.latest_reason ?? null,
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
  generationId: string | null;
  publishedAt: number | null;
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
  if (params.observation?.lastPublishedAt == null || params.publishedAt == null
    || params.observation.lastPublishedAt < params.publishedAt
    || (params.observation.lastPublishedGenerationId != null
      && params.observation.lastPublishedGenerationId !== params.generationId)) {
    return { degraded: null, reason: "producer-publication-unconfirmed", streakDegradedRuns: null };
  }
  if (streakDegradedRuns != null && streakDegradedRuns > 0) {
    return { degraded: true, reason: params.observation?.latestReason ?? "producer-quality-reason-unavailable", streakDegradedRuns };
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
  /** Collects keys whose D1 read was rejected, apart from content that was read (R2). */
  rejectedReads: string[];
}): Promise<SentinelBackedFreshnessResult> {
  const diagnostics: CacheFreshnessDiagnostic[] = [];
  const failures: CacheStatusFailure[] = [];
  const warnings: string[] = [];

  const sentinelKey = getFreshnessSentinelCacheKey(params.key);
  const sentinelRow = params.cacheRowsByKey.get(sentinelKey);
  // The caller may retain its scheduled/run-start clock. The pointer read and
  // validation use this D1 read clock (the same one sentinel validation uses),
  // so a generation published during the run is not mislabeled as future.
  const readClock = sentinelRow?.observed_at
    ?? params.cacheRowsByKey.get(DEWS_PUBLICATION_POINTER_CACHE_KEY)?.observed_at
    ?? params.now;
  const sentinelValidation = sentinelRow
    ? validateFreshnessSentinelPayload({
        value: sentinelRow.value,
        rowUpdatedAt: sentinelRow.updated_at,
        expectedSource: getFreshnessSentinelProducerJob(params.key),
        expectedGenerationId: sentinelRow.served_generation_id ?? null,
        // The caller may retain its scheduled/run-start clock across probes.
        // Compare against this read's clock so concurrent publication is not
        // mislabeled as future; no future-skew allowance is introduced.
        now: sentinelRow.observed_at ?? params.now,
      })
    : null;

  const freshnessOutcome = (
    ageSeconds: number | null,
    freshnessSource: CacheFreshnessDiagnostic["freshnessSource"] | null,
    publishedAt: number | null = null,
  ): SentinelBackedFreshnessResult => ({
    ageSeconds,
    timestampReason: null,
    freshnessSource,
    generationId: freshnessSource === "freshness-sentinel" ? sentinelValidation?.payload?.generationId ?? null : null,
    publishedAt: freshnessSource === "freshness-sentinel" && sentinelValidation?.payload?.generationId
      ? sentinelValidation.payload.updatedAt : publishedAt,
    ...(sentinelValidation?.reason ? { sentinelValidationReason: sentinelValidation.reason } : {}),
    quality: buildCacheQuality({
      freshnessSource,
      generationId: sentinelValidation?.payload?.generationId ?? null,
      publishedAt: sentinelValidation?.payload?.updatedAt ?? null,
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

  const readAge = TABLE_FRESHNESS_READERS[params.key];
  try {
    if (!readAge) throw new Error(`No table freshness fallback configured for ${params.key}`);
    const tableAge = await readAge(params.db, params.now, readClock);
    if (tableAge != null) {
      recordFreshnessOutcome("table-fallback", sentinelFailureSource, sentinelValidation?.reason);
      const assessment = assessFreshnessTimestamp(params.now, params.now - tableAge);
      return { ...freshnessOutcome(assessment.ageSeconds, "table-fallback", assessment.reason == null ? params.now - tableAge : null), timestampReason: assessment.reason };
    }
  } catch (error) {
    failures.push({
      key: params.key,
      source: "table-freshness",
      message: toErrorMessage(error),
    });
    if (readAge && (params.key !== "dews" || error instanceof DewsPublicationPointerReadError)) {
      params.rejectedReads.push(params.key);
    }
    if (params.key === "dews") {
      return freshnessOutcome(null, null);
    }
  }

  const cronFallbackTimestamp = params.cronHistory.value?.get(params.key)?.lastPublishedAt ?? null;
  if (cronFallbackTimestamp != null) {
    recordFreshnessOutcome(
      "cron-fallback",
      failures[0]?.source ?? sentinelFailureSource,
      sentinelValidation?.reason,
    );
    const assessment = assessFreshnessTimestamp(params.now, cronFallbackTimestamp);
    return { ...freshnessOutcome(assessment.ageSeconds, "cron-fallback", assessment.reason == null ? cronFallbackTimestamp : null), timestampReason: assessment.reason };
  }

  if (params.cronHistory.error) {
    failures.push({
      key: params.key,
      source: "cron-fallback",
      message: params.cronHistory.error,
    });
    params.rejectedReads.push(params.key);
  }

  return freshnessOutcome(null, null);
}

export async function buildCacheStatuses(
  db: D1Database,
  now: number,
  /** Restrict the read to these cache keys (e.g. a bounded sentinel re-read); default is every lane. */
  options: { keys?: readonly string[] } = {},
): Promise<{
  caches: Record<string, CacheStatus>;
  worstRatio: number;
  failures: CacheStatusFailure[];
  /** Keys (`__cache__` for the whole table) whose D1 read was rejected; content errors are not listed. */
  rejectedReads: string[];
  diagnostics: CacheFreshnessDiagnostic[];
  statusFloor: "healthy" | "degraded" | "stale";
  warnings: string[];
}> {
  const includeKey = (key: string) => options.keys == null || options.keys.includes(key);
  const sentinelBackedCacheKeys = listFreshnessSentinelBackedCacheKeys().filter(includeKey);
  const sentinelBackedCacheKeySet = new Set<string>(sentinelBackedCacheKeys);
  const sentinelCacheKeys = options.keys == null
    ? listFreshnessSentinelCacheKeys()
    : sentinelBackedCacheKeys.map((key) => getFreshnessSentinelCacheKey(key));
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (key) => !sentinelBackedCacheKeySet.has(key) && includeKey(key),
  );
  const fxMetaKey = getFxRatesMetaKey();
  const cacheLookupKeys = Array.from(
    new Set([
      ...cacheOnlyKeys,
      ...sentinelCacheKeys,
      ...(sentinelBackedCacheKeySet.has("dews") ? [DEWS_PUBLICATION_POINTER_CACHE_KEY] : []),
      ...(cacheOnlyKeys.includes("fx-rates") ? [fxMetaKey] : []),
    ]),
  );
  let cacheRows: { results?: CacheRow[] } = { results: [] };
  const failures: CacheStatusFailure[] = [];
  const rejectedReads: string[] = [];

  if (cacheLookupKeys.length > 0) {
    try {
      const inClause = buildInClause(cacheLookupKeys);
      cacheRows = await db
        .prepare(`SELECT key, value, updated_at, unixepoch() AS observed_at,
          CASE key
            WHEN 'freshness:yield-data' THEN ${YIELD_SERVED_GENERATION_SQL}
            WHEN 'freshness:dews' THEN ${DEWS_SERVED_GENERATION_SQL}
            WHEN 'freshness:dex-liquidity' THEN ${DEX_LIQUIDITY_SERVED_GENERATION_SQL}
          END AS served_generation_id
          FROM cache WHERE key IN (${inClause.sql})`)
        .bind(...inClause.binds)
        .all<CacheRow>();
    } catch (err) {
      failures.push({
        key: "__cache__",
        source: "cache-table",
        message: toErrorMessage(err),
      });
      rejectedReads.push("__cache__");
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
    ? hydrateFxRateStateFromCacheRows(cacheRowsByKey)
    : null;
  const cronHistory = await readProducerCronHistory(db, sentinelBackedCacheKeys);

  for (const [key, maxAge] of Object.entries(CACHE_FRESHNESS_THRESHOLDS)) {
    if (!includeKey(key)) continue;
    let ageSeconds: number | null;
    let generationId: string | null = null;
    let publishedAt: number | null = null;
    let timestampReason: FreshnessTimestampReason | null = null;

    if (key === "fx-rates") {
      const fx = buildFxCacheStatus(fxState, maxAge, now);
      caches[key] = { ...fx.cacheStatus, publishedAt: fx.cacheStatus.timestampReason == null ? fxState?.usableSyncAt ?? null : null };
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
        rejectedReads,
      });
      ageSeconds = freshness.ageSeconds;
      generationId = freshness.generationId;
      publishedAt = freshness.publishedAt;
      timestampReason = freshness.timestampReason;
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
      const assessment = assessFreshnessTimestamp(now, cacheUpdatedAtByKey.get(key));
      ageSeconds = assessment.ageSeconds;
      timestampReason = assessment.reason;
      publishedAt = assessment.reason == null ? cacheUpdatedAtByKey.get(key) ?? null : null;
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
        ...(timestampReason ? { timestampReason } : {}),
        maxAge,
        healthyMaxRatio,
        healthyMaxAge: maxAge * healthyMaxRatio,
        publishedAt,
        ...(sentinelBackedCacheKeySet.has(key) ? { generationId } : {}),
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

  return { caches, worstRatio, failures, rejectedReads, diagnostics, statusFloor, warnings };
}
