import { jsonResponse } from "../lib/api-response";
import type { HealthResponse } from "@shared/types/status";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { loadStatusRawSnapshot } from "../lib/status/raw-snapshot";
import { loadSchedulerLiveness, schedulerLivenessImpactStatus, schedulerLivenessWarnings } from "../lib/status/scheduler-liveness";
import { maxPublicStatus } from "@shared/lib/public-health";

export const handleHealth = async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const [snapshot, schedulerLiveness] = await Promise.all([
    loadStatusRawSnapshot(db, now), loadSchedulerLiveness(db, now),
  ]);
  const cachedSchedulerUnhealthy = snapshot.kind === "fresh" && snapshot.publicHealth
    && (snapshot.publicHealth.schedulerLiveness?.status !== "healthy"
      || snapshot.publicHealth.schedulerLiveness?.heavy?.status !== "healthy"
      || snapshot.publicHealth.warnings.some((warning) =>
        warning === "scheduled_delivery_stalled" || warning === "scheduler_liveness_unavailable"
        || warning === "heavy_scheduled_delivery_stalled" || warning === "heavy_scheduler_liveness_unavailable"));
  if (snapshot.kind === "fresh" && snapshot.publicHealth && !cachedSchedulerUnhealthy) {
    const status = maxPublicStatus(snapshot.publicHealth.status,
      schedulerLivenessImpactStatus(schedulerLiveness));
    return jsonResponse({
      ...snapshot.publicHealth, timestamp: now, status, schedulerLiveness,
      warnings: [...snapshot.publicHealth.warnings.filter((warning) =>
        warning !== "scheduled_delivery_stalled" && warning !== "scheduler_liveness_unavailable"
        && warning !== "heavy_scheduled_delivery_stalled" && warning !== "heavy_scheduler_liveness_unavailable"),
      ...schedulerLivenessWarnings(schedulerLiveness)],
    }, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
  }

  const assessment = await assessPublicHealth(db, now, { logPrefix: "health", schedulerLiveness });
  const body: HealthResponse = buildPublicHealthResponse(assessment, now);
  return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
};
