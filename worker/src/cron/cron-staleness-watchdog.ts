import {
  CACHE_FRESHNESS_LANES,
  type CacheFreshnessLaneKey,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import type { CacheStatus } from "@shared/types/status";
import { sendAlert } from "../lib/alerts";
import type { CronResult } from "../lib/cron-logger";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
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

export interface CronStalenessObservation {
  laneKey: CacheFreshnessLaneKey;
  cacheKey: string;
  producerJob: string;
  ageSeconds: number | null;
  thresholdSec: number;
}

interface AlertMarker {
  firstStaleAt: number;
  lastObservedAt: number;
  lastAlertedAt: number;
}

function alertCacheKey(cacheKey: string): string {
  return `${ALERT_CACHE_PREFIX}${cacheKey}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) {
    return "missing";
  }
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function readMarker(value: string | null | undefined): AlertMarker | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AlertMarker>;
    if (
      typeof parsed.firstStaleAt === "number" &&
      typeof parsed.lastObservedAt === "number" &&
      typeof parsed.lastAlertedAt === "number"
    ) {
      return {
        firstStaleAt: parsed.firstStaleAt,
        lastObservedAt: parsed.lastObservedAt,
        lastAlertedAt: parsed.lastAlertedAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildObservation(
  laneKey: CacheFreshnessLaneKey,
  lane: CacheFreshnessLaneConfig,
  cache: Pick<CacheStatus, "ageSeconds"> | undefined,
): CronStalenessObservation | null {
  const thresholdSec = lane.producerIntervalSec * 2;
  const ageSeconds = cache?.ageSeconds ?? null;
  if (ageSeconds != null && ageSeconds <= thresholdSec) {
    return null;
  }

  return {
    laneKey,
    cacheKey: lane.cacheKey,
    producerJob: lane.producerJob,
    ageSeconds,
    thresholdSec,
  };
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
    `- ${observation.cacheKey} (${observation.producerJob}): age ${formatDuration(observation.ageSeconds)}, threshold ${formatDuration(observation.thresholdSec)}`,
  );
  return [
    `Detected stale Tier-1 cron-backed caches at ${new Date(nowSec * 1000).toISOString()}.`,
    ...lines,
  ].join("\n");
}

function buildRecoveryMessage(recovered: readonly CronStalenessObservation[], nowSec: number): string {
  const lines = recovered.map((observation) =>
    `- ${observation.cacheKey} (${observation.producerJob}) recovered below ${formatDuration(observation.thresholdSec)}`,
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
  for (const observation of observations) {
    const row = await getCache(db, alertCacheKey(observation.cacheKey));
    markers.set(observation.cacheKey, readMarker(row?.value));
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
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = await buildCacheStatuses(db, nowSec);
  const stale = evaluateCronStaleness(status.caches);
  const watchedObservations = WATCHED_LANE_KEYS.map((laneKey) => {
    const lane = CACHE_FRESHNESS_LANES[laneKey];
    return {
      laneKey,
      cacheKey: lane.cacheKey,
      producerJob: lane.producerJob,
      ageSeconds: status.caches[lane.cacheKey]?.ageSeconds ?? null,
      thresholdSec: lane.producerIntervalSec * 2,
    } satisfies CronStalenessObservation;
  });
  const markers = await loadAlertMarkers(db, watchedObservations);
  const staleCacheKeys = new Set(stale.map((observation) => observation.cacheKey));
  const dueForAlert = stale.filter((observation) => {
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
    const delivered = await sendAlert(alertWebhookUrl, "Cron freshness stale", buildAlertMessage(dueForAlert, nowSec));
    if (delivered) {
      for (const observation of dueForAlert) {
        alertedCacheKeys.add(observation.cacheKey);
      }
    }
  }

  const recoveredAlertedCacheKeys = new Set<string>();
  const recoveryAlertFailedCacheKeys = new Set<string>();
  if (recovered.length > 0) {
    const alertableRecovered = recovered.filter((observation) => (markers.get(observation.cacheKey)?.lastAlertedAt ?? 0) > 0);
    let recoveredAlertDelivered = alertableRecovered.length === 0;
    if (alertableRecovered.length > 0) {
      recoveredAlertDelivered = await sendAlert(alertWebhookUrl, "Cron freshness recovered", buildRecoveryMessage(alertableRecovered, nowSec));
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

  return {
    status: stale.length > 0 ? "degraded" : "ok",
    itemCount: stale.length,
    metadata: JSON.stringify({
      stale,
      attemptedAlerts: dueForAlert.map((observation) => observation.cacheKey),
      alerted: [...alertedCacheKeys],
      failedAlerts: dueForAlert
        .filter((observation) => !alertedCacheKeys.has(observation.cacheKey))
        .map((observation) => observation.cacheKey),
      suppressed: stale
        .filter((observation) => !alertedCacheKeys.has(observation.cacheKey))
        .map((observation) => observation.cacheKey),
      recovered: recovered.map((observation) => observation.cacheKey),
      deliveredRecoveryAlerts: [...recoveredAlertedCacheKeys],
      failedRecoveryAlerts: [...recoveryAlertFailedCacheKeys],
      warnings: status.warnings,
      failures: status.failures,
      diagnostics: status.diagnostics,
    }),
  };
}
