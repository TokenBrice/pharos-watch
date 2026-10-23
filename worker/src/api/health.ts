import { jsonResponse } from "../lib/api-response";
import type { HealthResponse } from "@shared/types/status";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { advancePublicHealthSnapshot, loadStatusPublicHealthSnapshot } from "../lib/status/public-health-snapshot";
import { loadSchedulerLiveness, schedulerLivenessImpactStatus, schedulerLivenessWarnings } from "../lib/status/scheduler-liveness";
import { maxPublicStatus } from "@shared/lib/public-health";
import { holdPublicStatusAtReadTime, projectPublicStatus } from "@shared/lib/public-status-components";
import { getCacheFreshnessStatus } from "@shared/lib/cache-health";
import { buildCacheStatuses } from "../lib/api-freshness";
import { listFreshnessSentinelBackedCacheKeys } from "../lib/freshness-sentinels";
import { logWorkerEvent } from "../lib/structured-log";

/**
 * Re-read only the freshness sentinels of lanes the stored snapshot already
 * grades late, so a producer that published since the snapshot clears at
 * once. Bounded (sentinel lanes, only when late) and fail-closed: any read
 * failure keeps the stored snapshot's ages.
 */
async function readRecoveredSentinelCaches(db: D1Database, now: number, health: HealthResponse) {
  const keys = listFreshnessSentinelBackedCacheKeys().filter((key) => {
    const cache = health.caches[key];
    return cache != null && getCacheFreshnessStatus(cache, key) !== "healthy";
  });
  if (keys.length === 0) return null;
  try {
    const current = await buildCacheStatuses(db, now, { keys });
    return current.failures.length === 0 ? current.caches : null;
  } catch (error) {
    logWorkerEvent({
      scope: "status", level: "warn", event: "health_sentinel_reread_failed", route: "health",
      message: "Freshness sentinel re-read failed; serving the stored snapshot ages.", error,
    });
    return null;
  }
}

export const handleHealth = async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  // Only the admitted public projection is read; the operator envelope is never touched.
  const [snapshot, schedulerLiveness] = await Promise.all([
    loadStatusPublicHealthSnapshot(db, now), loadSchedulerLiveness(db, now),
  ]);
  const cachedHealth = snapshot.kind === "fresh" ? snapshot.payload.publicHealth : null;
  const cachedSchedulerUnhealthy = cachedHealth != null
    && (cachedHealth.schedulerLiveness?.status !== "healthy"
      || cachedHealth.schedulerLiveness?.heavy?.status !== "healthy"
      || cachedHealth.warnings.some((warning) =>
        warning === "scheduled_delivery_stalled" || warning === "scheduler_liveness_unavailable"
        || warning === "heavy_scheduled_delivery_stalled" || warning === "heavy_scheduler_liveness_unavailable"));
  if (cachedHealth != null && !cachedSchedulerUnhealthy) {
    const statusExcludingCacheFreshness = snapshot.kind === "fresh" ? snapshot.payload.statusExcludingCacheFreshness : undefined;
    const advanced = advancePublicHealthSnapshot(cachedHealth, now);
    const currentCaches = statusExcludingCacheFreshness != null
      ? await readRecoveredSentinelCaches(db, now, advanced)
      : null;
    const agedHealth = currentCaches
      ? advancePublicHealthSnapshot(cachedHealth, now, { statusExcludingCacheFreshness, currentCaches })
      : advanced;
    const status = maxPublicStatus(agedHealth.status,
      schedulerLivenessImpactStatus(schedulerLiveness));
    const body: HealthResponse = {
      ...agedHealth, status, schedulerLiveness,
      warnings: [...cachedHealth.warnings.filter((warning) =>
        warning !== "scheduled_delivery_stalled" && warning !== "scheduler_liveness_unavailable"
        && warning !== "heavy_scheduled_delivery_stalled" && warning !== "heavy_scheduler_liveness_unavailable"),
      ...schedulerLivenessWarnings(schedulerLiveness)],
    };
    // Re-project over advancing cache ages and the live scheduler overlay;
    // persisted `since` survives only for components whose state did not change.
    // The snapshot's components are already published through hysteresis, so a
    // read-time change honours it (outage and read-time recovery excepted).
    const since = Object.fromEntries((cachedHealth.components ?? [])
      .map((component) => [component.id, { state: component.state, since: component.since }]));
    const live = projectPublicStatus(body, since);
    const projection = cachedHealth.components
      ? holdPublicStatusAtReadTime(live, cachedHealth.components, projectPublicStatus(cachedHealth))
      : live;
    return jsonResponse({ ...body, ...projection },
      { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
  }

  const assessment = await assessPublicHealth(db, now, { logPrefix: "health", schedulerLiveness });
  const body: HealthResponse = { ...buildPublicHealthResponse(assessment, now), assessedAt: now };
  return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
};
