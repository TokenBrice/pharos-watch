import {
  CACHE_FRESHNESS_LANES,
  type CacheFreshnessLaneKey,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import type { CacheStatus } from "@shared/types/status";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
import { runChunkedInFilter } from "../lib/db";
import { buildCacheStatuses } from "../lib/api-freshness";

const WATCHED_LANE_KEYS = [
  "stablecoins",
  "fxRates",
  "dexLiquidity",
  "yieldData",
  "dews",
] as const satisfies readonly CacheFreshnessLaneKey[];

// Markers written by the detail handler when a per-coin cache write fails or
// exceeds the D1 value cap (see stablecoin-detail/shared.ts). Demand-refreshed
// detail rows can't be age-monitored like cron lanes (an old row may just be
// an unvisited coin), so the write failure itself is the staleness signal.
const DETAIL_WRITE_FAILURE_FRESH_SEC = 24 * 3600;
const DETAIL_WRITE_FAILURE_RETENTION_SEC = 7 * 24 * 3600;

export interface DetailWriteFailureObservation {
  stablecoinId: string;
  reason: string;
  bytes: number | null;
  ageSeconds: number;
}

export async function loadDetailWriteFailures(
  db: D1Database,
  nowSec: number,
): Promise<DetailWriteFailureObservation[]> {
  // Prune markers past retention so resolved incidents age out of the table.
  await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cache WHERE key LIKE ? AND updated_at < ?")
      .bind(`${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`, nowSec - DETAIL_WRITE_FAILURE_RETENTION_SEC)
      .run(),
  );

  const rows = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT key, value, updated_at FROM cache WHERE key LIKE ? AND updated_at >= ?")
      .bind(`${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`, nowSec - DETAIL_WRITE_FAILURE_FRESH_SEC)
      .all<{ key: string; value: string; updated_at: number }>(),
  );

  const markerRows = rows.results ?? [];

  // Batch-read the corresponding detail rows' updated_at in a single IN query
  // instead of one getCacheUpdatedAt round-trip per marker.
  const detailKeyByMarkerKey = new Map(
    markerRows.map((row) => [row.key, `detail:${row.key.slice(DETAIL_WRITE_FAILURE_KEY_PREFIX.length)}`]),
  );
  const detailUpdatedAtByKey = new Map<string, number>();
  if (detailKeyByMarkerKey.size > 0) {
    await runChunkedInFilter(
      [...new Set(detailKeyByMarkerKey.values())],
      (inClauseSql) => `SELECT key, updated_at FROM cache WHERE key IN (${inClauseSql})`,
      async (sql, binds) => {
        const detailRows = await runWithOverloadRetry(() =>
          db
            .prepare(sql)
            .bind(...binds)
            .all<{ key: string; updated_at: number }>(),
        );
        for (const detailRow of detailRows.results ?? []) {
          detailUpdatedAtByKey.set(detailRow.key, detailRow.updated_at);
        }
      },
    );
  }

  const failures: DetailWriteFailureObservation[] = [];
  const recoveredMarkerKeys: string[] = [];
  for (const row of markerRows) {
    const stablecoinId = row.key.slice(DETAIL_WRITE_FAILURE_KEY_PREFIX.length);

    // A detail row written after the marker means a later cache write
    // succeeded; the coin has recovered, so drop the stale marker instead of
    // degrading runs for up to 24h.
    const detailUpdatedAt = detailUpdatedAtByKey.get(detailKeyByMarkerKey.get(row.key) ?? "");
    if (detailUpdatedAt != null && detailUpdatedAt > row.updated_at) {
      recoveredMarkerKeys.push(row.key);
      continue;
    }

    let reason = "unknown";
    let bytes: number | null = null;
    try {
      const parsed = JSON.parse(row.value) as { reason?: unknown; bytes?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
      if (typeof parsed.bytes === "number") bytes = parsed.bytes;
    } catch {
      // keep defaults
    }
    failures.push({
      stablecoinId,
      reason,
      bytes,
      ageSeconds: Math.max(0, nowSec - row.updated_at),
    });
  }

  // Drop recovered markers in a single batched delete instead of per-row.
  if (recoveredMarkerKeys.length > 0) {
    await runChunkedInFilter(
      recoveredMarkerKeys,
      (inClauseSql) => `DELETE FROM cache WHERE key IN (${inClauseSql})`,
      async (sql, binds) => {
        await runWithOverloadRetry(() =>
          db
            .prepare(sql)
            .bind(...binds)
            .run(),
        );
      },
    );
  }
  return failures;
}

export interface CronStalenessObservation {
  laneKey: CacheFreshnessLaneKey;
  cacheKey: string;
  producerJob: string;
  ageSeconds: number | null;
  thresholdSec: number;
  producerThresholdSec: number;
  endpointThresholdSec: number;
  availabilityThresholdSec: number;
  availabilityImpacting: boolean;
}

function isFreshAge(ageSeconds: number | null, thresholdSec: number): boolean {
  return ageSeconds != null && Number.isFinite(ageSeconds) && ageSeconds <= thresholdSec;
}

function buildFullObservation(
  laneKey: CacheFreshnessLaneKey,
  lane: CacheFreshnessLaneConfig,
  cache: Pick<CacheStatus, "ageSeconds"> | undefined,
): CronStalenessObservation {
  const thresholdSec = lane.producerIntervalSec * 2;
  const ageSeconds = cache?.ageSeconds ?? null;
  return {
    laneKey,
    cacheKey: lane.cacheKey,
    producerJob: lane.producerJob,
    ageSeconds,
    thresholdSec,
    producerThresholdSec: thresholdSec,
    endpointThresholdSec: lane.endpointMaxAgeSec,
    availabilityThresholdSec: lane.availabilityMaxAgeSec,
    availabilityImpacting: !isFreshAge(ageSeconds, lane.availabilityMaxAgeSec),
  };
}

function isStale(observation: CronStalenessObservation): boolean {
  return !isFreshAge(observation.ageSeconds, observation.thresholdSec);
}

function buildDependencyRecoveryChecks(observations: readonly CronStalenessObservation[]): Array<{
  root: string;
  dependent: string;
  state: "both-stale" | "root-recovered-dependent-stale" | "healthy" | "unknown";
  rootAgeSeconds: number | null;
  dependentAgeSeconds: number | null;
}> {
  const byCacheKey = new Map(observations.map((observation) => [observation.cacheKey, observation]));
  const dexLiquidity = byCacheKey.get("dex-liquidity");
  const dews = byCacheKey.get("dews");
  if (!dexLiquidity || !dews) {
    return [
      {
        root: "dex-liquidity",
        dependent: "dews",
        state: "unknown",
        rootAgeSeconds: dexLiquidity?.ageSeconds ?? null,
        dependentAgeSeconds: dews?.ageSeconds ?? null,
      },
    ];
  }

  const rootStale = isStale(dexLiquidity);
  const dependentStale = isStale(dews);
  const state =
    rootStale && dependentStale
      ? "both-stale"
      : !rootStale && dependentStale
        ? "root-recovered-dependent-stale"
        : "healthy";
  return [
    {
      root: "dex-liquidity",
      dependent: "dews",
      state,
      rootAgeSeconds: dexLiquidity.ageSeconds,
      dependentAgeSeconds: dews.ageSeconds,
    },
  ];
}

function buildObservation(
  laneKey: CacheFreshnessLaneKey,
  lane: CacheFreshnessLaneConfig,
  cache: Pick<CacheStatus, "ageSeconds"> | undefined,
): CronStalenessObservation | null {
  const observation = buildFullObservation(laneKey, lane, cache);
  return isStale(observation) ? observation : null;
}

export function evaluateCronStaleness(
  caches: Record<string, Pick<CacheStatus, "ageSeconds"> | undefined>,
  laneKeys: readonly CacheFreshnessLaneKey[] = WATCHED_LANE_KEYS,
): CronStalenessObservation[] {
  return laneKeys.flatMap((laneKey) => {
    const lane = CACHE_FRESHNESS_LANES[laneKey];
    const observation = buildObservation(laneKey, lane, caches[lane.cacheKey]);
    return observation ? [observation] : [];
  });
}

export async function runCronStalenessWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = await buildCacheStatuses(db, nowSec);
  const watchedObservations = WATCHED_LANE_KEYS.map((laneKey) =>
    buildFullObservation(
      laneKey,
      CACHE_FRESHNESS_LANES[laneKey],
      status.caches[CACHE_FRESHNESS_LANES[laneKey].cacheKey],
    ),
  );
  const stale = watchedObservations.filter(isStale);
  const dependencyRecoveryChecks = buildDependencyRecoveryChecks(watchedObservations);

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("cron staleness watchdog aborted");
  }

  const detailWriteFailures = await loadDetailWriteFailures(db, nowSec);

  return {
    status: stale.length > 0 || detailWriteFailures.length > 0 ? "degraded" : "ok",
    itemCount: stale.length + detailWriteFailures.length,
    metadata: JSON.stringify({
      stale,
      detailWriteFailures,
      dependencyRecoveryChecks,
      warnings: status.warnings,
      failures: status.failures,
      diagnostics: status.diagnostics,
    }),
  };
}
