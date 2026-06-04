import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { isBlacklistAmountGapStatus } from "@shared/lib/blacklist";

export interface BlacklistGapMetrics {
  totalEvents: number;
  missingAmounts: number;
  recentMissingAmounts: number;
  recentWindowSec: number;
  missingRatio: number;
  unrecoverableMissingAmounts: number;
  oldestRecoverableAgeSec: number | null;
  neverAttemptedCount: number;
  repeatedFailureCount: number;
  statusDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
}

export interface BlacklistGapMetricsOptions {
  recentWindowSec?: number;
  includeDistributions?: boolean;
  cacheTtlSec?: number;
}

const BLACKLIST_GAP_METRICS_CACHE_VERSION = 1;
const DEFAULT_BLACKLIST_GAP_METRICS_CACHE_TTL_SEC = 300;

interface CachedBlacklistGapMetricsPayload {
  version: typeof BLACKLIST_GAP_METRICS_CACHE_VERSION;
  includeDistributions: boolean;
  recentWindowSec: number;
  metrics: BlacklistGapMetrics;
}

function normalizeOptions(input: number | BlacklistGapMetricsOptions | undefined): Required<BlacklistGapMetricsOptions> {
  if (typeof input === "number") {
    return {
      recentWindowSec: input,
      includeDistributions: true,
      cacheTtlSec: 0,
    };
  }
  return {
    recentWindowSec: input?.recentWindowSec ?? BLACKLIST_RECENT_WINDOW_SEC,
    includeDistributions: input?.includeDistributions ?? true,
    cacheTtlSec: input?.cacheTtlSec ?? 0,
  };
}

function getCacheKey(options: Required<BlacklistGapMetricsOptions>): string {
  return `blacklist:gap-metrics:v${BLACKLIST_GAP_METRICS_CACHE_VERSION}:${options.recentWindowSec}:${options.includeDistributions ? "full" : "core"}`;
}

function isMetricsPayload(value: unknown): value is BlacklistGapMetrics {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const candidate = value as Partial<BlacklistGapMetrics>;
  return (
    typeof candidate.totalEvents === "number"
    && typeof candidate.missingAmounts === "number"
    && typeof candidate.recentMissingAmounts === "number"
    && typeof candidate.recentWindowSec === "number"
    && typeof candidate.missingRatio === "number"
    && typeof candidate.unrecoverableMissingAmounts === "number"
    && (typeof candidate.oldestRecoverableAgeSec === "number" || candidate.oldestRecoverableAgeSec == null)
    && typeof candidate.neverAttemptedCount === "number"
    && typeof candidate.repeatedFailureCount === "number"
    && typeof candidate.statusDistribution === "object"
    && candidate.statusDistribution != null
    && !Array.isArray(candidate.statusDistribution)
    && typeof candidate.sourceDistribution === "object"
    && candidate.sourceDistribution != null
    && !Array.isArray(candidate.sourceDistribution)
  );
}

function parseCachedMetrics(
  value: string,
  options: Required<BlacklistGapMetricsOptions>,
): BlacklistGapMetrics | null {
  try {
    const payload = JSON.parse(value) as Partial<CachedBlacklistGapMetricsPayload>;
    if (
      payload.version !== BLACKLIST_GAP_METRICS_CACHE_VERSION
      || payload.includeDistributions !== options.includeDistributions
      || payload.recentWindowSec !== options.recentWindowSec
      || !isMetricsPayload(payload.metrics)
    ) {
      return null;
    }
    return payload.metrics;
  } catch {
    return null;
  }
}

function ageCachedMetrics(metrics: BlacklistGapMetrics, cachedAt: number, now: number): BlacklistGapMetrics {
  if (metrics.oldestRecoverableAgeSec == null) return metrics;
  return {
    ...metrics,
    oldestRecoverableAgeSec: metrics.oldestRecoverableAgeSec + Math.max(0, now - cachedAt),
  };
}

async function readCachedMetrics(
  db: D1Database,
  now: number,
  options: Required<BlacklistGapMetricsOptions>,
): Promise<BlacklistGapMetrics | null> {
  if (options.cacheTtlSec <= 0) return null;
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(getCacheKey(options))
    .first<{ value: string; updated_at: number }>();
  if (!row || now - row.updated_at > options.cacheTtlSec) return null;
  const metrics = parseCachedMetrics(row.value, options);
  return metrics ? ageCachedMetrics(metrics, row.updated_at, now) : null;
}

async function writeCachedMetrics(
  db: D1Database,
  now: number,
  options: Required<BlacklistGapMetricsOptions>,
  metrics: BlacklistGapMetrics,
): Promise<void> {
  if (options.cacheTtlSec <= 0) return;
  const payload: CachedBlacklistGapMetricsPayload = {
    version: BLACKLIST_GAP_METRICS_CACHE_VERSION,
    includeDistributions: options.includeDistributions,
    recentWindowSec: options.recentWindowSec,
    metrics,
  };
  await db
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(getCacheKey(options), JSON.stringify(payload), now)
    .run();
}

export async function queryBlacklistGapMetrics(
  db: D1Database,
  now: number,
  optionsInput?: number | BlacklistGapMetricsOptions,
): Promise<BlacklistGapMetrics> {
  const options = normalizeOptions(optionsInput);
  const cached = await readCachedMetrics(db, now, options);
  if (cached) return cached;

  const gapStatuses = [
    "recoverable_pending",
    "provider_failed",
    "ambiguous",
  ].filter((status) => isBlacklistAmountGapStatus(status as Parameters<typeof isBlacklistAmountGapStatus>[0]));
  const gapStatusSql = gapStatuses.map((status) => `'${status}'`).join(", ");
  const rowPromise = db
    .prepare(
      `/* blacklist-gap-aggregate */
         SELECT
           COUNT(*) as total,
           SUM(
             CASE
               WHEN amount_status IN (${gapStatusSql})
               THEN 1
               ELSE 0
             END
           ) as missing,
           SUM(
             CASE
               WHEN amount_status IN (${gapStatusSql})
                 AND timestamp >= ?
               THEN 1
               ELSE 0
             END
           ) as missing_recent,
           MAX(
             CASE
               WHEN amount_status IN (${gapStatusSql})
               THEN ? - timestamp
               ELSE NULL
             END
           ) as oldest_gap_age_sec,
           SUM(
             CASE
               WHEN amount_status IN (${gapStatusSql})
                 AND COALESCE(amount_attempt_count, 0) = 0
               THEN 1
               ELSE 0
             END
           ) as never_attempted,
           SUM(
             CASE
               WHEN amount_status IN ('provider_failed', 'ambiguous')
                 AND COALESCE(amount_attempt_count, 0) >= 3
               THEN 1
               ELSE 0
             END
           ) as repeated_failures,
           SUM(
             CASE
               WHEN amount_status = 'permanently_unavailable'
               THEN 1
               ELSE 0
             END
           ) as unrecoverable
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL`,
    )
    .bind(now - options.recentWindowSec, now)
    .first<{
      total: number;
      missing: number | null;
      missing_recent: number | null;
      oldest_gap_age_sec: number | null;
      never_attempted: number | null;
      repeated_failures: number | null;
      unrecoverable: number | null;
    }>();

  const statusRowsPromise = options.includeDistributions
    ? db
      .prepare(
        `/* blacklist-gap-status-distribution */
         SELECT amount_status, COUNT(*) AS n
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL
         GROUP BY amount_status`,
      )
      .all<{ amount_status: string | null; n: number }>()
    : Promise.resolve({ results: [] as Array<{ amount_status: string | null; n: number }> });

  const sourceRowsPromise = options.includeDistributions
    ? db
      .prepare(
        `/* blacklist-gap-source-distribution */
         SELECT amount_source, COUNT(*) AS n
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL
         GROUP BY amount_source`,
      )
      .all<{ amount_source: string | null; n: number }>()
    : Promise.resolve({ results: [] as Array<{ amount_source: string | null; n: number }> });

  const [row, statusRows, sourceRows] = await Promise.all([
    rowPromise,
    statusRowsPromise,
    sourceRowsPromise,
  ]);

  const totalEvents = row?.total ?? 0;
  const missingAmounts = row?.missing ?? 0;
  const recentMissingAmounts = row?.missing_recent ?? 0;
  const statusDistribution = Object.fromEntries(
    (statusRows.results ?? []).map((statusRow) => [statusRow.amount_status ?? "unknown", statusRow.n]),
  );
  const sourceDistribution = Object.fromEntries(
    (sourceRows.results ?? []).map((sourceRow) => [sourceRow.amount_source ?? "unknown", sourceRow.n]),
  );

  const metrics: BlacklistGapMetrics = {
    totalEvents,
    missingAmounts,
    recentMissingAmounts,
    recentWindowSec: options.recentWindowSec,
    missingRatio: totalEvents > 0 ? missingAmounts / totalEvents : 0,
    unrecoverableMissingAmounts: row?.unrecoverable ?? 0,
    oldestRecoverableAgeSec: row?.oldest_gap_age_sec ?? null,
    neverAttemptedCount: row?.never_attempted ?? 0,
    repeatedFailureCount: row?.repeated_failures ?? 0,
    statusDistribution,
    sourceDistribution,
  };
  await writeCachedMetrics(db, now, options, metrics).catch((error) => {
    console.warn("[blacklist-gaps] Failed to write cached metrics:", error);
  });
  return metrics;
}

export const BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC = DEFAULT_BLACKLIST_GAP_METRICS_CACHE_TTL_SEC;
