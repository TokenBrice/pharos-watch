import { jsonResponse } from "../lib/api-response";
import type { HealthResponse } from "@shared/types/status";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { advancePublicHealthSnapshot, loadStatusPublicHealthSnapshot } from "../lib/status/public-health-snapshot";
import { loadSchedulerLiveness, schedulerLivenessImpactStatus, schedulerLivenessWarnings } from "../lib/status/scheduler-liveness";
import { maxPublicStatus } from "@shared/lib/public-health";
import { projectPublicStatus } from "@shared/lib/public-status-components";

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
    const agedHealth = advancePublicHealthSnapshot(cachedHealth, now);
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
    const since = Object.fromEntries((cachedHealth.components ?? [])
      .map((component) => [component.id, { state: component.state, since: component.since }]));
    return jsonResponse({ ...body, ...projectPublicStatus(body, since) },
      { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
  }

  const assessment = await assessPublicHealth(db, now, { logPrefix: "health", schedulerLiveness });
  const body: HealthResponse = { ...buildPublicHealthResponse(assessment, now), assessedAt: now };
  return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
};
