import { logWorkerEventArgs } from "./structured-log";
import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isBlacklistAmountGapStatus } from "@shared/lib/blacklist";
import { BLACKLIST_AMOUNT_STATUS_VALUES } from "@shared/types/market";
import {
  BLACKLIST_GAP_METRICS_CACHE_VERSION,
  getBlacklistGapMetricsCacheKey,
  type BlacklistGapMetricsCacheKind,
} from "./blacklist-cache-keys";

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
  producerSnapshotTtlSec?: number;
  cacheTtlSec?: number;
}

const DEFAULT_BLACKLIST_GAP_METRICS_CACHE_TTL_SEC = 300;
const DEFAULT_BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC =
  API_FRESHNESS_MAX_AGE_SEC.blacklistSummary * 2;

interface CachedBlacklistGapMetricsPayload {
  version: typeof BLACKLIST_GAP_METRICS_CACHE_VERSION;
  materializedAt?: number;
  includeDistributions: boolean;
  recentWindowSec: number;
  metrics: BlacklistGapMetrics;
}

function normalizeOptions(input: number | BlacklistGapMetricsOptions | undefined): Required<BlacklistGapMetricsOptions> {
  if (typeof input === "number") {
    return {
      recentWindowSec: input,
      includeDistributions: true,
      producerSnapshotTtlSec: 0,
      cacheTtlSec: 0,
    };
  }
  return {
    recentWindowSec: input?.recentWindowSec ?? BLACKLIST_RECENT_WINDOW_SEC,
    includeDistributions: input?.includeDistributions ?? true,
    producerSnapshotTtlSec: input?.producerSnapshotTtlSec ?? 0,
    cacheTtlSec: input?.cacheTtlSec ?? 0,
  };
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
): { metrics: BlacklistGapMetrics; materializedAt: number | null } | null {
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
    return {
      metrics: payload.metrics,
      materializedAt: typeof payload.materializedAt === "number" && Number.isFinite(payload.materializedAt)
        ? payload.materializedAt
        : null,
    };
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
  kind: BlacklistGapMetricsCacheKind,
): Promise<BlacklistGapMetrics | null> {
  const ttlSec = kind === "producer" ? options.producerSnapshotTtlSec : options.cacheTtlSec;
  if (ttlSec <= 0) return null;
  const row = await db
    .prepare("/* blacklist-gap-metrics-cache-read */ SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(getBlacklistGapMetricsCacheKey(options, kind))
    .first<{ value: string; updated_at: number }>();
  if (!row || now - row.updated_at > ttlSec) return null;
  const parsed = parseCachedMetrics(row.value, options);
  return parsed
    ? ageCachedMetrics(parsed.metrics, parsed.materializedAt ?? row.updated_at, now)
    : null;
}

async function writeCachedMetrics(
  db: D1Database,
  now: number,
  options: Required<BlacklistGapMetricsOptions>,
  metrics: BlacklistGapMetrics,
): Promise<void> {
  if (options.cacheTtlSec <= 0) return;
  await writeMetricsCacheRow(db, now, options, metrics, "request");
}

async function writeMetricsCacheRow(
  db: D1Database,
  freshnessAt: number,
  options: Pick<Required<BlacklistGapMetricsOptions>, "recentWindowSec" | "includeDistributions">,
  metrics: BlacklistGapMetrics,
  kind: BlacklistGapMetricsCacheKind,
  materializedAt = freshnessAt,
): Promise<void> {
  const payload: CachedBlacklistGapMetricsPayload = {
    version: BLACKLIST_GAP_METRICS_CACHE_VERSION,
    materializedAt,
    includeDistributions: options.includeDistributions,
    recentWindowSec: options.recentWindowSec,
    metrics,
  };
  await db
    .prepare("/* blacklist-gap-metrics-cache-write */ INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(getBlacklistGapMetricsCacheKey(options, kind), JSON.stringify(payload), freshnessAt)
    .run();
}

// Derived from the shared enum — never hardcode these strings in SQL.
const PERMANENTLY_UNAVAILABLE_STATUS = BLACKLIST_AMOUNT_STATUS_VALUES.find(
  (s) => s === "permanently_unavailable",
)!;
const REPEATED_FAILURE_STATUSES = BLACKLIST_AMOUNT_STATUS_VALUES.filter(
  (s) => s === "provider_failed" || s === "ambiguous",
);

async function queryLiveBlacklistGapMetrics(
  db: D1Database,
  now: number,
  options: Required<BlacklistGapMetricsOptions>,
): Promise<BlacklistGapMetrics> {
  const gapStatuses = BLACKLIST_AMOUNT_STATUS_VALUES.filter((status) =>
    isBlacklistAmountGapStatus(status),
  );
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
               WHEN amount_status IN (${REPEATED_FAILURE_STATUSES.map((s) => `'${s}'`).join(", ")})
                 AND COALESCE(amount_attempt_count, 0) >= 3
               THEN 1
               ELSE 0
             END
           ) as repeated_failures,
           SUM(
             CASE
               WHEN amount_status = '${PERMANENTLY_UNAVAILABLE_STATUS}'
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
  return metrics;
}

export async function queryBlacklistGapMetrics(
  db: D1Database,
  now: number,
  optionsInput?: number | BlacklistGapMetricsOptions,
): Promise<BlacklistGapMetrics> {
  const options = normalizeOptions(optionsInput);
  const producerSnapshot = await readCachedMetrics(db, now, options, "producer");
  if (producerSnapshot) return producerSnapshot;

  const requestCached = await readCachedMetrics(db, now, options, "request");
  if (requestCached) return requestCached;

  const metrics = await queryLiveBlacklistGapMetrics(db, now, options);
  await writeCachedMetrics(db, now, options, metrics).catch((error) => {
    logWorkerEventArgs("lib", "warn", "[blacklist-gaps] Failed to write cached metrics:", error);
  });
  return metrics;
}

export async function materializeBlacklistGapMetrics(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  recentWindowSec = BLACKLIST_RECENT_WINDOW_SEC,
  producerFreshnessAt = now,
): Promise<{ written: number }> {
  const freshnessAt = Math.min(now, Math.max(0, Math.floor(producerFreshnessAt)));
  const fullOptions = normalizeOptions({
    recentWindowSec,
    includeDistributions: true,
  });
  const fullMetrics = await queryLiveBlacklistGapMetrics(db, now, fullOptions);
  const coreOptions = normalizeOptions({
    recentWindowSec,
    includeDistributions: false,
  });
  const coreMetrics: BlacklistGapMetrics = {
    ...fullMetrics,
    statusDistribution: {},
    sourceDistribution: {},
  };

  await Promise.all([
    writeMetricsCacheRow(db, freshnessAt, fullOptions, fullMetrics, "producer", now),
    writeMetricsCacheRow(db, freshnessAt, coreOptions, coreMetrics, "producer", now),
  ]);

  return { written: 2 };
}

export const BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC = DEFAULT_BLACKLIST_GAP_METRICS_CACHE_TTL_SEC;
export const BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC =
  DEFAULT_BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC;
