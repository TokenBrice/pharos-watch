import { HealthResponseSchema, type HealthResponse } from "@shared/types/status";
import { z } from "zod";
import { getCacheHealthyMaxRatio } from "@shared/lib/status-thresholds";
import { getOverallCacheImpactStatus, maxPublicStatus } from "@shared/lib/public-health";
import { assessFreshnessTimestamp } from "../api-freshness-age";
import { STATUS_SYSTEM_FRESHNESS_SEC } from "../status-reliability-shared";
import { loadStatusSnapshotPayload, writeStatusSnapshotPayload, type StatusSnapshotLoadResult } from "./status-snapshot-cache";

/**
 * The admitted public-health projection published by the status self-check.
 * `/api/health` reads only this key (plus its live scheduler overlay), never
 * the operator assessment envelope in `status:raw-snapshot:v1`.
 */
export const STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY = "status:public-health-snapshot:v1";
const STATUS_PUBLIC_HEALTH_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;

const StatusPublicHealthSnapshotPayloadSchema = z.object({
  version: z.literal(1),
  producedAt: z.number().finite(),
  publicHealth: HealthResponseSchema,
});

export function loadStatusPublicHealthSnapshot(
  db: D1Database,
  now: number,
  maxAgeSec = STATUS_PUBLIC_HEALTH_SNAPSHOT_MAX_AGE_SEC,
): Promise<StatusSnapshotLoadResult<z.output<typeof StatusPublicHealthSnapshotPayloadSchema>>> {
  return loadStatusSnapshotPayload(
    db, STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, StatusPublicHealthSnapshotPayloadSchema, now, maxAgeSec,
  );
}

/** Age admitted evidence without rereading the assessment or renewing its clock. */
export function advancePublicHealthSnapshot(publicHealth: HealthResponse, now: number): HealthResponse {
  const assessedAt = publicHealth.assessedAt ?? publicHealth.timestamp;
  const elapsed = assessFreshnessTimestamp(now, assessedAt);
  const caches: HealthResponse["caches"] = {};
  for (const [key, cache] of Object.entries(publicHealth.caches)) {
    // Rejected or unreadable evidence must not become fresh as wall time advances.
    const age = cache.timestampReason != null || cache.ageSeconds == null
      ? { ageSeconds: null, reason: cache.timestampReason ?? null }
      : cache.publishedAt != null
        ? assessFreshnessTimestamp(now, cache.publishedAt)
        : elapsed.reason != null
          ? elapsed
          : { ageSeconds: cache.ageSeconds + elapsed.ageSeconds, reason: null };
    const aged = {
      ...cache,
      ageSeconds: age.ageSeconds,
      ...(age.reason != null ? { timestampReason: age.reason } : {}),
    };
    caches[key] = {
      ...aged,
      healthy: cache.healthy && age.ageSeconds != null
        && age.ageSeconds <= (cache.healthyMaxAge ?? cache.maxAge * getCacheHealthyMaxRatio(key)),
    };
  }
  return {
    ...publicHealth,
    timestamp: now,
    assessedAt,
    caches,
    // The prior assessment also contains independent quality and availability floors.
    status: maxPublicStatus(publicHealth.status, getOverallCacheImpactStatus(caches)),
  };
}

export function writeStatusPublicHealthSnapshot(
  db: D1Database,
  now: number,
  publicHealth: HealthResponse,
): Promise<boolean> {
  return writeStatusSnapshotPayload(db, STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, now, {
    version: 1,
    producedAt: now,
    publicHealth: { ...publicHealth, assessedAt: publicHealth.assessedAt ?? publicHealth.timestamp },
  });
}
