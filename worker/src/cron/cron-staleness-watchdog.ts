import {
  CACHE_FRESHNESS_LANES,
  type CacheFreshnessLaneKey,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import { CRON_JOB_DEFINITIONS, type CronJobMeta } from "@shared/lib/cron-jobs";
import type { CacheStatus } from "@shared/types/status";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
import { runChunkedInFilter } from "../lib/db";
import { buildCacheStatuses } from "../lib/api-freshness";
import { getCache, setCache } from "../lib/db-cache";
import { escapeHtml, type TelegramCreds } from "../lib/telegram";
import { deliverWatchdogTransitions } from "./shared/watchdog-transition-alert";

const NO_CONSUMER_FRESHNESS_SURFACE_JOBS = new Set([
  // Control-plane observers and watchdogs produce telemetry, not consumer data.
  "cron-slot-sweeper",
  "reserve-recovery",
  "cron-staleness-watchdog",
  "telegram-degradation-watchdog",
  "dex-exit-route-turnover-watchdog",
  "reserve-post-sync-watchdog",
  "mint-burn-growth-watchdog",
  "cron-duration-watchdog",
  // Delivery/planning jobs mutate transport state rather than a freshness surface.
  "dispatch-telegram-alerts",
  "telegram-personalized-recap-planner",
  // Retention and repair jobs only delete or reconcile internal rows.
  "telegram-disambiguation-cleanup",
  "prune-status-probe-runs",
  "prune-cron-history",
  "worker-repair-runner",
  "prune-detail-cache",
  "telegram-inactive-cleanup",
  "telegram-retention-cleanup",
]);

// Registry-derived lanes prove freshness from cron_runs MAX(started_at), and
// prune-cron-history deletes cron_runs rows older than one week. A producer
// whose 3x-interval staleness threshold exceeds that retention (e.g. the
// monthly yield-coverage-audit) can never be observed fresh here and would
// alert forever; such cadences need their own audit trail, not this watchdog.
const CRON_RUNS_OBSERVABILITY_RETENTION_SEC = 7 * 24 * 3600;

const WATCHDOG_STATE_KEY = "cron-staleness-watchdog:producer-state:v1";
const WATCHDOG_ALERT_KEY = "cron-staleness-watchdog:alert:direct:v1";
export const CRON_STALENESS_ALERT_COOLDOWN_SEC = 30 * 60;

export interface ProducerFreshnessLane {
  producerJob: string;
  laneKey: CacheFreshnessLaneKey | null;
  cacheKey: string | null;
  producerIntervalSec: number;
  thresholdSec: number;
}

export function deriveCronFreshnessProducers(
  definitions: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS,
): ProducerFreshnessLane[] {
  const cacheLaneByProducer = new Map(
    (Object.entries(CACHE_FRESHNESS_LANES) as Array<[CacheFreshnessLaneKey, CacheFreshnessLaneConfig]>).map(
      ([laneKey, lane]) => [lane.producerJob, { laneKey, lane }],
    ),
  );

  return definitions.flatMap((definition): ProducerFreshnessLane[] => {
    if (NO_CONSUMER_FRESHNESS_SURFACE_JOBS.has(definition.job)) return [];
    const cacheLane = cacheLaneByProducer.get(definition.job);
    if (cacheLane) {
      return [{
        producerJob: definition.job,
        laneKey: cacheLane.laneKey,
        cacheKey: cacheLane.lane.cacheKey,
        producerIntervalSec: cacheLane.lane.producerIntervalSec,
        thresholdSec: cacheLane.lane.producerIntervalSec * 2,
      }];
    }
    if (definition.intervalSec * 3 > CRON_RUNS_OBSERVABILITY_RETENTION_SEC) return [];
    return [{
      producerJob: definition.job,
      laneKey: null,
      cacheKey: null,
      producerIntervalSec: definition.intervalSec,
      // Registry producers without an existing lane budget tolerate two missed
      // runs and become stale at 3x their canonical producer interval.
      thresholdSec: definition.intervalSec * 3,
    }];
  });
}

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
  laneKey: CacheFreshnessLaneKey | null;
  cacheKey: string | null;
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

function buildCronObservation(
  producer: ProducerFreshnessLane,
  lastSuccessfulAt: number | null,
  nowSec: number,
): CronStalenessObservation {
  const ageSeconds = lastSuccessfulAt == null ? null : Math.max(0, nowSec - lastSuccessfulAt);
  return {
    laneKey: producer.laneKey,
    cacheKey: producer.cacheKey,
    producerJob: producer.producerJob,
    ageSeconds,
    thresholdSec: producer.thresholdSec,
    producerThresholdSec: producer.thresholdSec,
    endpointThresholdSec: producer.thresholdSec,
    availabilityThresholdSec: producer.thresholdSec,
    availabilityImpacting: !isFreshAge(ageSeconds, producer.thresholdSec),
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
  const byCacheKey = new Map(
    observations.flatMap((observation) => observation.cacheKey == null ? [] : [[observation.cacheKey, observation] as const]),
  );
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
  laneKeys: readonly CacheFreshnessLaneKey[] = deriveCronFreshnessProducers()
    .flatMap((producer) => producer.laneKey == null ? [] : [producer.laneKey]),
): CronStalenessObservation[] {
  return laneKeys.flatMap((laneKey) => {
    const lane = CACHE_FRESHNESS_LANES[laneKey];
    const observation = buildObservation(laneKey, lane, caches[lane.cacheKey]);
    return observation ? [observation] : [];
  });
}

async function loadProducerSuccessTimestamps(
  db: D1Database,
  producerJobs: readonly string[],
): Promise<Map<string, number>> {
  const timestamps = new Map<string, number>();
  if (producerJobs.length === 0) return timestamps;
  await runChunkedInFilter(
    producerJobs,
    (inClauseSql) => `SELECT job, MAX(started_at) AS started_at FROM cron_runs WHERE status IN ('ok', 'degraded') AND job IN (${inClauseSql}) GROUP BY job`,
    async (sql, binds) => {
      const rows = await runWithOverloadRetry(() =>
        db.prepare(sql).bind(...binds).all<{ job: string; started_at: number | null }>(),
      );
      for (const row of rows.results ?? []) {
        if (row.started_at != null) timestamps.set(row.job, row.started_at);
      }
    },
  );
  return timestamps;
}

type ProducerFreshnessState = Record<string, "ok" | "stale">;

function parseProducerFreshnessState(value: string | null | undefined): ProducerFreshnessState {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, "ok" | "stale"] =>
        entry[1] === "ok" || entry[1] === "stale"),
    );
  } catch {
    return {};
  }
}

export interface CronStalenessWatchdogOptions {
  /**
   * Private operator chat credentials. Freshness transitions are ops signal,
   * not audience content: they must never be sent with the public digest
   * channel creds. Null suppresses the alert (state tracking still advances).
   */
  operatorTelegramCreds?: TelegramCreds | null;
}

async function alertOnFreshnessTransitions(params: {
  db: D1Database;
  observations: readonly CronStalenessObservation[];
  nowSec: number;
  operatorTelegramCreds: TelegramCreds | null;
  signal?: AbortSignal;
}): Promise<{ stale: string[]; recovered: string[]; sent: boolean; cooldown: boolean }> {
  const [stateCache, alertCache] = await Promise.all([
    getCache(params.db, WATCHDOG_STATE_KEY),
    getCache(params.db, WATCHDOG_ALERT_KEY),
  ]);
  const previous = parseProducerFreshnessState(stateCache?.value);
  const next: ProducerFreshnessState = {};
  const stale: string[] = [];
  const recovered: string[] = [];

  for (const observation of params.observations) {
    const current = isStale(observation) ? "stale" : "ok";
    const prior = previous[observation.producerJob] ?? "ok";
    next[observation.producerJob] = current;
    if (prior === current) continue;
    if (current === "stale") stale.push(observation.producerJob);
    else recovered.push(observation.producerJob);
  }
  await setCache(params.db, WATCHDOG_STATE_KEY, JSON.stringify(next));

  return deliverWatchdogTransitions({
    db: params.db,
    stale,
    recovered,
    hasCooldownConsumingTransition: stale.length > 0 || recovered.length > 0,
    alertCacheKey: WATCHDOG_ALERT_KEY,
    lastAlertValue: alertCache?.value,
    cooldownSec: CRON_STALENESS_ALERT_COOLDOWN_SEC,
    nowSec: params.nowSec,
    operatorTelegramCreds: params.operatorTelegramCreds,
    buildAlertText: () => {
      const sections = [
        stale.length > 0 ? `<b>Stale producers</b>: ${stale.map(escapeHtml).join(", ")}` : null,
        recovered.length > 0 ? `<b>Recovered producers</b>: ${recovered.map(escapeHtml).join(", ")}` : null,
      ].filter((section): section is string => section != null);
      return `<b>Pharos freshness watchdog</b>\n\n${sections.join("\n")}`;
    },
    signal: params.signal,
  });
}

export async function runCronStalenessWatchdog(
  db: D1Database,
  signal?: AbortSignal,
  options: CronStalenessWatchdogOptions = {},
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = await buildCacheStatuses(db, nowSec);
  const producers = deriveCronFreshnessProducers();
  const cronOnlyProducers = producers.filter((producer) => producer.laneKey == null);
  const producerSuccessTimestamps = await loadProducerSuccessTimestamps(
    db,
    cronOnlyProducers.map((producer) => producer.producerJob),
  );
  const watchedObservations = producers.map((producer) => producer.laneKey == null
    ? buildCronObservation(
        producer,
        producerSuccessTimestamps.get(producer.producerJob) ?? null,
        nowSec,
      )
    : buildFullObservation(
        producer.laneKey,
        CACHE_FRESHNESS_LANES[producer.laneKey],
        status.caches[CACHE_FRESHNESS_LANES[producer.laneKey].cacheKey],
      ));
  const stale = watchedObservations.filter(isStale);
  const dependencyRecoveryChecks = buildDependencyRecoveryChecks(watchedObservations);

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("cron staleness watchdog aborted");
  }

  const detailWriteFailures = await loadDetailWriteFailures(db, nowSec);
  const alertTransitions = await alertOnFreshnessTransitions({
    db,
    observations: watchedObservations,
    nowSec,
    operatorTelegramCreds: options.operatorTelegramCreds ?? null,
    signal,
  });

  return {
    status: stale.length > 0 || detailWriteFailures.length > 0 ? "degraded" : "ok",
    itemCount: stale.length + detailWriteFailures.length,
    metadata: JSON.stringify({
      checkedProducers: watchedObservations.map((observation) => observation.producerJob),
      stale,
      detailWriteFailures,
      alertTransitions,
      dependencyRecoveryChecks,
      warnings: status.warnings,
      failures: status.failures,
      diagnostics: status.diagnostics,
    }),
  };
}
