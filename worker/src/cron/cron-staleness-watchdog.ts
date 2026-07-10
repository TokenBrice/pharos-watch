import {
  CACHE_FRESHNESS_LANES,
  type CacheFreshnessLaneKey,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import { formatStalenessDurationSeconds } from "@shared/lib/relative-time";
import type { CacheStatus } from "@shared/types/status";
import { deliverOperationalAlert } from "../lib/operational-alert";
import { readAlertMarker } from "../lib/alert-marker";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { runChunkedInFilter } from "../lib/db";
import { buildCacheStatuses } from "../lib/api-freshness";

const WATCHED_LANE_KEYS = [
  "stablecoins",
  "fxRates",
  "dexLiquidity",
  "yieldData",
  "dews",
] as const satisfies readonly CacheFreshnessLaneKey[];

const ALERT_COOLDOWN_SEC = 3600;
const ALERT_CACHE_PREFIX = "cron-staleness-watchdog:alert:";

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
  await runWithOverloadRetry(() => db
    .prepare("DELETE FROM cache WHERE key LIKE ? AND updated_at < ?")
    .bind(`${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`, nowSec - DETAIL_WRITE_FAILURE_RETENTION_SEC)
    .run());

  const rows = await runWithOverloadRetry(() => db
    .prepare("SELECT key, value, updated_at FROM cache WHERE key LIKE ? AND updated_at >= ?")
    .bind(`${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`, nowSec - DETAIL_WRITE_FAILURE_FRESH_SEC)
    .all<{ key: string; value: string; updated_at: number }>());

  const markerRows = rows.results ?? [];

  // Batch-read the corresponding detail rows' updated_at in a single IN query
  // instead of one getCacheUpdatedAt round-trip per marker.
  const detailKeyByMarkerKey = new Map(
    markerRows.map((row) => [
      row.key,
      `detail:${row.key.slice(DETAIL_WRITE_FAILURE_KEY_PREFIX.length)}`,
    ]),
  );
  const detailUpdatedAtByKey = new Map<string, number>();
  if (detailKeyByMarkerKey.size > 0) {
    await runChunkedInFilter(
      [...new Set(detailKeyByMarkerKey.values())],
      (inClauseSql) => `SELECT key, updated_at FROM cache WHERE key IN (${inClauseSql})`,
      async (sql, binds) => {
        const detailRows = await runWithOverloadRetry(() =>
          db.prepare(sql).bind(...binds).all<{ key: string; updated_at: number }>(),
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
    // degrading runs and re-alerting for up to 24h.
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
        await runWithOverloadRetry(() => db.prepare(sql).bind(...binds).run());
      },
    );
  }
  return failures;
}

function buildDetailWriteFailureMessage(
  failures: readonly DetailWriteFailureObservation[],
  nowSec: number,
): string {
  const lines = failures.map((failure) =>
    `- detail:${failure.stablecoinId}: ${failure.reason}${failure.bytes != null ? ` (${failure.bytes} bytes)` : ""}, last failed ${formatStalenessDurationSeconds(failure.ageSeconds)} ago`,
  );
  return [
    `Per-coin detail cache writes are failing (serving via synchronous upstream refetch) at ${new Date(nowSec * 1000).toISOString()}.`,
    ...lines,
  ].join("\n");
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

interface AlertMarker {
  firstStaleAt: number;
  lastObservedAt: number;
  lastAlertedAt: number;
}

function alertCacheKey(cacheKey: string): string {
  return `${ALERT_CACHE_PREFIX}${cacheKey}`;
}

function readMarker(value: string | null | undefined): AlertMarker | null {
  return readAlertMarker<AlertMarker>(
    value,
    (p): p is AlertMarker =>
      typeof p.firstStaleAt === "number" &&
      typeof p.lastObservedAt === "number" &&
      typeof p.lastAlertedAt === "number",
  );
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
    return [{
      root: "dex-liquidity",
      dependent: "dews",
      state: "unknown",
      rootAgeSeconds: dexLiquidity?.ageSeconds ?? null,
      dependentAgeSeconds: dews?.ageSeconds ?? null,
    }];
  }

  const rootStale = isStale(dexLiquidity);
  const dependentStale = isStale(dews);
  const state =
    rootStale && dependentStale
      ? "both-stale"
      : !rootStale && dependentStale
        ? "root-recovered-dependent-stale"
        : "healthy";
  return [{
    root: "dex-liquidity",
    dependent: "dews",
    state,
    rootAgeSeconds: dexLiquidity.ageSeconds,
    dependentAgeSeconds: dews.ageSeconds,
  }];
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

function buildAlertMessage(stale: readonly CronStalenessObservation[], nowSec: number): string {
  const lines = stale.map((observation) =>
    `- ${observation.cacheKey} (${observation.producerJob}): age ${formatStalenessDurationSeconds(observation.ageSeconds)}, threshold ${formatStalenessDurationSeconds(observation.thresholdSec)}`,
  );
  return [
    `Detected stale Tier-1 cron-backed caches at ${new Date(nowSec * 1000).toISOString()}.`,
    ...lines,
  ].join("\n");
}

function buildRecoveryMessage(recovered: readonly CronStalenessObservation[], nowSec: number): string {
  const lines = recovered.map((observation) =>
    `- ${observation.cacheKey} (${observation.producerJob}) recovered below ${formatStalenessDurationSeconds(observation.thresholdSec)}`,
  );
  return [
    `Cron-backed cache freshness recovered at ${new Date(nowSec * 1000).toISOString()}.`,
    ...lines,
  ].join("\n");
}

async function loadAlertMarkers(
  db: D1Database,
  observations: readonly CronStalenessObservation[],
): Promise<Map<string, AlertMarker | null>> {
  const markers = new Map<string, AlertMarker | null>();
  if (observations.length === 0) return markers;

  const alertKeyToCacheKey = new Map(
    observations.map((observation) => [alertCacheKey(observation.cacheKey), observation.cacheKey]),
  );
  const valueByAlertKey = new Map<string, string>();
  await runChunkedInFilter(
    [...alertKeyToCacheKey.keys()],
    (inClauseSql) => `SELECT key, value FROM cache WHERE key IN (${inClauseSql})`,
    async (sql, binds) => {
      const rows = await runWithOverloadRetry(() =>
        db.prepare(sql).bind(...binds).all<{ key: string; value: string }>(),
      );
      for (const row of rows.results ?? []) {
        valueByAlertKey.set(row.key, row.value);
      }
    },
  );

  for (const [alertKey, cacheKey] of alertKeyToCacheKey) {
    markers.set(cacheKey, readMarker(valueByAlertKey.get(alertKey)));
  }
  return markers;
}

async function persistStaleMarkers(params: {
  db: D1Database;
  nowSec: number;
  stale: readonly CronStalenessObservation[];
  markers: Map<string, AlertMarker | null>;
  alertedCacheKeys: ReadonlySet<string>;
}): Promise<void> {
  for (const observation of params.stale) {
    const marker = params.markers.get(observation.cacheKey);
    await setCache(
      params.db,
      alertCacheKey(observation.cacheKey),
      JSON.stringify({
        firstStaleAt: marker?.firstStaleAt ?? params.nowSec,
        lastObservedAt: params.nowSec,
        lastAlertedAt: params.alertedCacheKeys.has(observation.cacheKey)
          ? params.nowSec
          : marker?.lastAlertedAt ?? 0,
      } satisfies AlertMarker),
    );
  }
}

export async function runCronStalenessWatchdog(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
  alertBrokerMode?: string,
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = await buildCacheStatuses(db, nowSec);
  const watchedObservations = WATCHED_LANE_KEYS.map((laneKey) =>
    buildFullObservation(laneKey, CACHE_FRESHNESS_LANES[laneKey], status.caches[CACHE_FRESHNESS_LANES[laneKey].cacheKey]),
  );
  const stale = watchedObservations.filter(isStale);
  const dependencyRecoveryChecks = buildDependencyRecoveryChecks(watchedObservations);
  const markers = await loadAlertMarkers(db, watchedObservations);
  const staleCacheKeys = new Set(stale.map((observation) => observation.cacheKey));
  const dueForAlert = alertBrokerMode != null ? stale : stale.filter((observation) => {
    const marker = markers.get(observation.cacheKey);
    return alertWebhookUrl && nowSec - (marker?.lastAlertedAt ?? 0) >= ALERT_COOLDOWN_SEC;
  });
  const recovered = watchedObservations.filter((observation) =>
    !staleCacheKeys.has(observation.cacheKey) && markers.get(observation.cacheKey),
  );

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("cron staleness watchdog aborted");
  }

  const alertedCacheKeys = new Set<string>();
  if (dueForAlert.length > 0) {
    const delivered = await deliverOperationalAlert({
      db,
      conditionKey: "watchdog:cron-freshness-stale",
      active: true,
      severity: "critical",
      title: "Cron freshness stale",
      message: buildAlertMessage(dueForAlert, nowSec),
      recoveryTitle: "Cron freshness recovered",
      recoveryMessage: "All watched cron freshness lanes are within their availability budgets.",
      fingerprint: { watchdog: "cron-freshness-stale" },
      metadata: { staleCacheKeys: stale.map((entry) => entry.cacheKey) },
      webhookUrl: alertWebhookUrl,
      brokerMode: alertBrokerMode,
      cooldownSec: ALERT_COOLDOWN_SEC,
    });
    if (delivered) {
      for (const observation of dueForAlert) {
        alertedCacheKeys.add(observation.cacheKey);
      }
    }
  } else if (alertBrokerMode != null) {
    await deliverOperationalAlert({
      db,
      conditionKey: "watchdog:cron-freshness-stale",
      active: false,
      severity: "critical",
      title: "Cron freshness stale",
      message: "All watched cron freshness lanes are current.",
      recoveryTitle: "Cron freshness recovered",
      recoveryMessage: "All watched cron freshness lanes are within their availability budgets.",
      webhookUrl: alertWebhookUrl,
      brokerMode: alertBrokerMode,
    });
  }

  const recoveredAlertedCacheKeys = new Set<string>();
  const recoveryAlertFailedCacheKeys = new Set<string>();
  if (recovered.length > 0) {
    const alertableRecovered = recovered.filter((observation) => (markers.get(observation.cacheKey)?.lastAlertedAt ?? 0) > 0);
    let recoveredAlertDelivered = alertBrokerMode != null || alertableRecovered.length === 0;
    if (alertableRecovered.length > 0 && alertBrokerMode == null) {
      recoveredAlertDelivered = await deliverOperationalAlert({
        db,
        conditionKey: "watchdog:cron-freshness-stale",
        active: false,
        severity: "critical",
        title: "Cron freshness stale",
        message: buildRecoveryMessage(alertableRecovered, nowSec),
        recoveryTitle: "Cron freshness recovered",
        recoveryMessage: buildRecoveryMessage(alertableRecovered, nowSec),
        webhookUrl: alertWebhookUrl,
      });
      for (const observation of alertableRecovered) {
        if (recoveredAlertDelivered) {
          recoveredAlertedCacheKeys.add(observation.cacheKey);
        } else {
          recoveryAlertFailedCacheKeys.add(observation.cacheKey);
        }
      }
    }
    for (const observation of recovered) {
      const markerWasAlerted = (markers.get(observation.cacheKey)?.lastAlertedAt ?? 0) > 0;
      if (!markerWasAlerted || recoveredAlertDelivered) {
        await deleteCache(db, alertCacheKey(observation.cacheKey));
      }
    }
  }

  await persistStaleMarkers({
    db,
    nowSec,
    stale,
    markers,
    alertedCacheKeys,
  });

  const detailWriteFailures = await loadDetailWriteFailures(db, nowSec);
  let detailFailureAlerted = false;
  if (detailWriteFailures.length > 0 && (alertWebhookUrl || alertBrokerMode != null)) {
    const detailMarkerKey = alertCacheKey("detail-write-failures");
    const detailMarkerRow = await getCache(db, detailMarkerKey);
    const detailMarker = readMarker(detailMarkerRow?.value);
    if (alertBrokerMode != null || nowSec - (detailMarker?.lastAlertedAt ?? 0) >= ALERT_COOLDOWN_SEC) {
      detailFailureAlerted = await deliverOperationalAlert({
        db,
        conditionKey: "watchdog:detail-cache-write-failures",
        active: true,
        severity: "warning",
        title: "Detail cache writes failing",
        message: buildDetailWriteFailureMessage(detailWriteFailures, nowSec),
        recoveryTitle: "Detail cache writes recovered",
        recoveryMessage: "No recent detail-cache write failure markers remain.",
        fingerprint: { watchdog: "detail-cache-write-failures" },
        metadata: { failureCount: detailWriteFailures.length },
        webhookUrl: alertWebhookUrl,
        brokerMode: alertBrokerMode,
        cooldownSec: ALERT_COOLDOWN_SEC,
      });
      await setCache(
        db,
        detailMarkerKey,
        JSON.stringify({
          firstStaleAt: detailMarker?.firstStaleAt ?? nowSec,
          lastObservedAt: nowSec,
          lastAlertedAt: detailFailureAlerted ? nowSec : detailMarker?.lastAlertedAt ?? 0,
        } satisfies AlertMarker),
      );
    }
  } else if (alertBrokerMode != null) {
    await deliverOperationalAlert({
      db,
      conditionKey: "watchdog:detail-cache-write-failures",
      active: false,
      severity: "warning",
      title: "Detail cache writes failing",
      message: "No recent detail-cache write failure markers remain.",
      recoveryTitle: "Detail cache writes recovered",
      recoveryMessage: "No recent detail-cache write failure markers remain.",
      webhookUrl: alertWebhookUrl,
      brokerMode: alertBrokerMode,
    });
  }

  return {
    status: stale.length > 0 || detailWriteFailures.length > 0 ? "degraded" : "ok",
    itemCount: stale.length + detailWriteFailures.length,
    metadata: JSON.stringify({
      stale,
      detailWriteFailures,
      detailFailureAlerted,
      attemptedAlerts: dueForAlert.map((observation) => observation.cacheKey),
      alerted: [...alertedCacheKeys],
      failedAlerts: dueForAlert
        .filter((observation) => !alertedCacheKeys.has(observation.cacheKey))
        .map((observation) => observation.cacheKey),
      suppressed: stale
        .filter((observation) => !alertedCacheKeys.has(observation.cacheKey))
        .map((observation) => observation.cacheKey),
      recovered: recovered.map((observation) => observation.cacheKey),
      dependencyRecoveryChecks,
      deliveredRecoveryAlerts: [...recoveredAlertedCacheKeys],
      failedRecoveryAlerts: [...recoveryAlertFailedCacheKeys],
      warnings: status.warnings,
      failures: status.failures,
      diagnostics: status.diagnostics,
    }),
  };
}
