import type { StatusResponse } from "@shared/types/status";
import type { CronHealthSnapshot } from "./cron-health";

type StatusSummary = StatusResponse["summary"];

export function emptyStatusSummary(): StatusSummary {
  return {
    unhealthyCrons: null,
    availabilityImpactingUnhealthyCrons: null,
    watchUnhealthyCrons: null,
    degradedCrons: null,
    cronErrors: null,
    availabilityImpactingCronErrors: null,
    availabilityImpactingConsecutiveCronErrors: null,
    staleCronArtifacts: null,
    expiredCronLeases: null,
    orphanedCronProgressRows: null,
    scheduledSlotRunning: null,
    scheduledSlotStaleCandidates: null,
    scheduledSlotOldestRunningAgeSec: null,
    budgetOnlySurfaceCount: null,
    budgetOnlySurfaceMissingTelemetry: null,
    budgetOnlySurfaceStaleTelemetry: null,
    budgetOnlySurfaceErrors: null,
    diagnosticIssueCount: null,
    worstCacheRatio: null,
    transitionsLast24h: null,
    transitionsUnavailableReason: "db-unavailable",
    unavailableReason: "db-unavailable",
  };
}

export function buildStatusSummary(input: {
  cronHealth: CronHealthSnapshot;
  budgetOnlySurfaces: StatusResponse["budgetOnlySurfaces"];
  diagnosticIssueCount: number | null;
  worstCacheRatio: number | null;
  transitionsLast24h: number | null;
  transitionsUnavailableReason?: StatusSummary["transitionsUnavailableReason"];
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
    transitionsUnavailableReason: input.transitionsUnavailableReason ?? null,
  };
}
