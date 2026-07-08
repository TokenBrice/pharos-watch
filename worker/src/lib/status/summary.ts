import type { StatusResponse } from "@shared/types/status";
import type { CronHealthSnapshot } from "./cron-health";

type StatusSummary = StatusResponse["summary"];

export function emptyStatusSummary(): StatusSummary {
  return {
    unhealthyCrons: 0,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 0,
    degradedCrons: 0,
    cronErrors: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    staleCronArtifacts: 0,
    expiredCronLeases: 0,
    orphanedCronProgressRows: 0,
    activeJobAttempts: 0,
    staleJobAttempts: 0,
    scheduledSlotRunning: 0,
    scheduledSlotStaleCandidates: 0,
    scheduledSlotOldestRunningAgeSec: null,
    budgetOnlySurfaceCount: 0,
    budgetOnlySurfaceMissingTelemetry: 0,
    budgetOnlySurfaceStaleTelemetry: 0,
    budgetOnlySurfaceErrors: 0,
    diagnosticIssueCount: 0,
    worstCacheRatio: 0,
    transitionsLast24h: 0,
  };
}

export function buildStatusSummary(input: {
  cronHealth: CronHealthSnapshot;
  budgetOnlySurfaces: StatusResponse["budgetOnlySurfaces"];
  diagnosticIssueCount: number;
  worstCacheRatio: number;
  transitionsLast24h: number;
}): StatusSummary {
  const { cronHealth } = input;
  const scheduledSlotQueryFailures = {
    ...(cronHealth.scheduledSlots.queryFailed ? { scheduledSlotRunningQueryFailed: true } : {}),
    ...(cronHealth.scheduledSlotEventMarkerQueryFailed ? { scheduledSlotEventMarkerQueryFailed: true } : {}),
  };
  return {
    unhealthyCrons: cronHealth.unhealthyCrons,
    availabilityImpactingUnhealthyCrons: cronHealth.availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons: cronHealth.watchUnhealthyCrons,
    degradedCrons: cronHealth.degradedCronRuns,
    cronErrors: cronHealth.cronErrorCount,
    availabilityImpactingCronErrors: cronHealth.availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors: cronHealth.availabilityImpactingConsecutiveCronErrors,
    staleCronArtifacts: cronHealth.staleCronArtifacts,
    expiredCronLeases: cronHealth.expiredCronLeases,
    orphanedCronProgressRows: cronHealth.orphanedCronProgressRows,
    activeJobAttempts: cronHealth.activeJobAttempts,
    staleJobAttempts: cronHealth.staleJobAttempts,
    scheduledSlotRunning: cronHealth.scheduledSlots.runningSlots,
    scheduledSlotStaleCandidates: cronHealth.scheduledSlots.staleCandidateSlots,
    scheduledSlotOldestRunningAgeSec: cronHealth.scheduledSlots.oldestRunningAgeSec,
    ...scheduledSlotQueryFailures,
    budgetOnlySurfaceCount: input.budgetOnlySurfaces.length,
    budgetOnlySurfaceMissingTelemetry: input.budgetOnlySurfaces.filter((surface) => surface.telemetryStatus === "missing").length,
    budgetOnlySurfaceStaleTelemetry: input.budgetOnlySurfaces.filter((surface) => surface.telemetryStatus === "stale").length,
    budgetOnlySurfaceErrors: input.budgetOnlySurfaces.filter((surface) => surface.outcome === "error").length,
    diagnosticIssueCount: input.diagnosticIssueCount,
    worstCacheRatio: input.worstCacheRatio,
    transitionsLast24h: input.transitionsLast24h,
  };
}
