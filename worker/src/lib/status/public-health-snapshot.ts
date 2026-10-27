import { HealthResponseSchema, type CacheStatus, type HealthResponse } from "@shared/types/status";
import { z } from "zod";
import { getCacheHealthyMaxRatio } from "@shared/lib/status-thresholds";
import {
  CACHE_QUALITY_WARNING_PREFIXES,
  getCacheQualityImpact,
  getOverallCacheImpactStatus,
  maxPublicStatus,
} from "@shared/lib/public-health";
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
  // Additive: older payloads lack it and keep max-only aging (fail closed).
  statusExcludingCacheFreshness: HealthResponseSchema.shape.status.optional(),
  // Additive: the floor without any cache-owned verdict; absent keeps the legacy floor.
  statusExcludingCacheEvidence: HealthResponseSchema.shape.status.optional(),
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

/**
 * Newer sentinel evidence a snapshot may adopt: a valid sentinel publication
 * with its own generation identity, published after the stored one. Invalid,
 * fallback, unchanged, older or future evidence keeps the stored lane aging.
 */
function isAdoptableGeneration(cache: CacheStatus, current: CacheStatus | undefined): current is CacheStatus {
  return current != null && current.freshnessSource === "freshness-sentinel"
    && current.timestampReason == null && current.ageSeconds != null
    && typeof current.generationId === "string" && current.generationId !== cache.generationId
    && current.publishedAt != null && cache.timestampReason == null && cache.publishedAt != null
    && current.publishedAt > cache.publishedAt;
}

/**
 * Age admitted evidence without rereading the assessment or renewing its clock.
 * `currentCaches` (a bounded freshness-sentinel re-read) may replace a lane
 * only with a newer generation, adopting that generation's complete status
 * (quality, health, budgets, provenance); only the upstream provider is kept.
 * Cache age and quality are then re-graded over the resulting caches. With
 * `statusExcludingCacheEvidence` the independent floor excludes every
 * cache-owned verdict, so a clean generation clears; the legacy
 * `statusExcludingCacheFreshness` floor still carries the stored quality.
 */
export function advancePublicHealthSnapshot(
  publicHealth: HealthResponse,
  now: number,
  options: {
    statusExcludingCacheFreshness?: HealthResponse["status"];
    statusExcludingCacheEvidence?: HealthResponse["status"];
    currentCaches?: Readonly<Record<string, CacheStatus>> | null;
  } = {},
): HealthResponse {
  const assessedAt = publicHealth.assessedAt ?? publicHealth.timestamp;
  const elapsed = assessFreshnessTimestamp(now, assessedAt);
  const caches: HealthResponse["caches"] = {};
  const adoptedKeys: string[] = [];
  for (const [key, cache] of Object.entries(publicHealth.caches)) {
    const current = options.currentCaches?.[key];
    if (isAdoptableGeneration(cache, current)) {
      caches[key] = {
        ...current,
        ...(cache.upstreamProvider !== undefined ? { upstreamProvider: cache.upstreamProvider } : {}),
      };
      adoptedKeys.push(key);
      continue;
    }
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
  const quality = getCacheQualityImpact(caches);
  // Only cache-owned warnings are replaced: quality over the resulting caches
  // and the adopted lanes' own diagnostics. Unrelated warnings are preserved.
  const warnings = adoptedKeys.length === 0 ? publicHealth.warnings : [
    ...publicHealth.warnings.filter((warning) =>
      !CACHE_QUALITY_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix))
      && !adoptedKeys.some((key) => warning.startsWith(`${key}: `))),
    ...quality.warnings,
    ...adoptedKeys.flatMap((key) => caches[key].warning ? [caches[key].warning] : []),
  ];
  return {
    ...publicHealth,
    timestamp: now,
    assessedAt,
    warnings,
    caches,
    // The prior assessment also contains independent quality and availability floors.
    status: maxPublicStatus(
      options.statusExcludingCacheEvidence ?? options.statusExcludingCacheFreshness ?? publicHealth.status,
      quality.status,
      getOverallCacheImpactStatus(caches),
    ),
  };
}

export function writeStatusPublicHealthSnapshot(
  db: D1Database,
  now: number,
  publicHealth: HealthResponse,
  statusExcludingCacheFreshness?: HealthResponse["status"],
  statusExcludingCacheEvidence?: HealthResponse["status"],
): Promise<boolean> {
  return writeStatusSnapshotPayload(db, STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, now, {
    version: 1,
    producedAt: now,
    publicHealth: { ...publicHealth, assessedAt: publicHealth.assessedAt ?? publicHealth.timestamp },
    ...(statusExcludingCacheFreshness != null ? { statusExcludingCacheFreshness } : {}),
    ...(statusExcludingCacheEvidence != null ? { statusExcludingCacheEvidence } : {}),
  });
}
