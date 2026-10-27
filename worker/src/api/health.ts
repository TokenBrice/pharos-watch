import { jsonResponse } from "../lib/api-response";
import type { HealthResponse } from "@shared/types/status";
import {
  assessPublicHealth,
  buildPublicHealthResponse,
  getPublicHealthEvidenceReadFailures,
  type PublicHealthAssessment,
} from "../lib/public-health-assessment";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { advancePublicHealthSnapshot, loadStatusPublicHealthSnapshot } from "../lib/status/public-health-snapshot";
import { loadSchedulerLiveness, schedulerLivenessImpactStatus, schedulerLivenessWarnings } from "../lib/status/scheduler-liveness";
import { getPublicMintBurnStatus, getPublicSafetyScoreStatus, maxPublicStatus } from "@shared/lib/public-health";
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

/** Names a request-time recovery assessment that could not be read; the snapshot is retained. */
const HEALTH_RECOVERY_READ_FAILED = "health-recovery-read-failed";

const isNonregressingClock = (next: number | null | undefined, prior: number | null | undefined) =>
  next != null && (prior == null || next >= prior);

/**
 * Safety Score publication and mint/burn sync are not sentinel lanes, so a
 * producer that recovered since the snapshot would wait for the next
 * self-check. When either retained lane is late/unavailable at read time,
 * held, or carries a run warning, one full assessment may replace the
 * snapshot, admitted only if every affected lane's accepted/sync clock is
 * present and nonregressing (the assessment already rejects future clocks).
 * Healthy evidence costs nothing; a failed read is never a recovery (R2).
 */
async function assessRetainedLaneRecovery(
  db: D1Database,
  now: number,
  health: HealthResponse,
  schedulerLiveness: Awaited<ReturnType<typeof loadSchedulerLiveness>>,
): Promise<PublicHealthAssessment | "retained" | "read-failed"> {
  const safety = health.safetyScorePublication;
  const refreshSafety = getPublicSafetyScoreStatus(safety, now) !== "healthy" || safety?.status === "held";
  const refreshMintBurn = getPublicMintBurnStatus(health.mintBurn.sync, now) !== "healthy"
    || health.mintBurn.sync.warning != null;
  if (!refreshSafety && !refreshMintBurn) return "retained";
  let assessment: PublicHealthAssessment;
  try {
    assessment = await assessPublicHealth(db, now, { logPrefix: "health", schedulerLiveness });
  } catch (error) {
    logWorkerEvent({
      scope: "status", level: "warn", event: "health_recovery_read_failed", route: "health",
      message: "Retained-lane recovery assessment failed; serving the stored snapshot.", error,
    });
    return "read-failed";
  }
  const failures = getPublicHealthEvidenceReadFailures(assessment);
  if (failures.length > 0) {
    logWorkerEvent({
      scope: "status", level: "warn", event: "health_recovery_read_failed", route: "health",
      message: `Retained-lane recovery evidence unreadable (${failures.join(", ")}); serving the stored snapshot.`,
    });
    return "read-failed";
  }
  const admitted = (!refreshSafety || isNonregressingClock(
    assessment.safetyScorePublication?.acceptedAtSec, safety?.acceptedAtSec))
    && (!refreshMintBurn || isNonregressingClock(
      assessment.mintBurn.sync.lastSuccessfulSyncAt, health.mintBurn.sync.lastSuccessfulSyncAt));
  return admitted ? assessment : "retained";
}

/**
 * Re-project over the request's evidence; persisted `since` survives only for
 * components whose state did not change. The snapshot's components are
 * already published through hysteresis, so a read-time change honours it
 * (outage and read-time recovery excepted).
 */
function projectOverSnapshot(body: HealthResponse, cachedHealth: HealthResponse) {
  const since = Object.fromEntries((cachedHealth.components ?? [])
    .map((component) => [component.id, { state: component.state, since: component.since }]));
  const live = projectPublicStatus(body, since);
  return cachedHealth.components
    ? holdPublicStatusAtReadTime(live, cachedHealth.components, projectPublicStatus(cachedHealth))
    : live;
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
    const recovery = await assessRetainedLaneRecovery(db, now, cachedHealth, schedulerLiveness);
    if (typeof recovery === "object") {
      const body: HealthResponse = { ...buildPublicHealthResponse(recovery, now), assessedAt: now };
      return jsonResponse({ ...body, ...projectOverSnapshot(body, cachedHealth) },
        { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
    }
    const statusExcludingCacheFreshness = snapshot.kind === "fresh" ? snapshot.payload.statusExcludingCacheFreshness : undefined;
    const statusExcludingCacheEvidence = snapshot.kind === "fresh" ? snapshot.payload.statusExcludingCacheEvidence : undefined;
    const advanced = advancePublicHealthSnapshot(cachedHealth, now);
    const currentCaches = statusExcludingCacheFreshness != null
      ? await readRecoveredSentinelCaches(db, now, advanced)
      : null;
    const agedHealth = currentCaches
      ? advancePublicHealthSnapshot(cachedHealth, now, {
        statusExcludingCacheFreshness, statusExcludingCacheEvidence, currentCaches,
      })
      : advanced;
    const status = maxPublicStatus(agedHealth.status,
      schedulerLivenessImpactStatus(schedulerLiveness));
    const body: HealthResponse = {
      ...agedHealth, status, schedulerLiveness,
      warnings: [...agedHealth.warnings.filter((warning) =>
        warning !== "scheduled_delivery_stalled" && warning !== "scheduler_liveness_unavailable"
        && warning !== "heavy_scheduled_delivery_stalled" && warning !== "heavy_scheduler_liveness_unavailable"),
      ...schedulerLivenessWarnings(schedulerLiveness),
      ...(recovery === "read-failed" ? [HEALTH_RECOVERY_READ_FAILED] : [])],
    };
    // Re-project over advancing cache ages and the live scheduler overlay.
    return jsonResponse({ ...body, ...projectOverSnapshot(body, cachedHealth) },
      { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
  }

  const assessment = await assessPublicHealth(db, now, { logPrefix: "health", schedulerLiveness });
  const body: HealthResponse = { ...buildPublicHealthResponse(assessment, now), assessedAt: now };
  return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
};
