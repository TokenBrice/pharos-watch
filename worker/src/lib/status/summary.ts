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
    cronHistoryUnavailableReason: null,
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
  const historyUnavailable = cronHealth.cronHistoryQueryFailed;
  const artifactsUnavailable = cronHealth.cronLeaseQueryFailed || cronHealth.cronProgressQueryFailed;
  const scheduledSlotQueryFailures = {
    ...(cronHealth.scheduledSlots.queryFailed ? { scheduledSlotRunningQueryFailed: true } : {}),
    ...(cronHealth.scheduledSlotEventMarkerQueryFailed ? { scheduledSlotEventMarkerQueryFailed: true } : {}),
  };
  return {
    unhealthyCrons: historyUnavailable ? null : cronHealth.unhealthyCrons,
    availabilityImpactingUnhealthyCrons: historyUnavailable ? null : cronHealth.availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons: historyUnavailable ? null : cronHealth.watchUnhealthyCrons,
    degradedCrons: historyUnavailable ? null : cronHealth.degradedCronRuns,
    cronErrors: historyUnavailable ? null : cronHealth.cronErrorCount,
    availabilityImpactingCronErrors: historyUnavailable ? null : cronHealth.availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors: historyUnavailable ? null : cronHealth.availabilityImpactingConsecutiveCronErrors,
    cronHistoryUnavailableReason: historyUnavailable ? "cron-history-read-failed" : null,
    staleCronArtifacts: artifactsUnavailable ? null : cronHealth.staleCronArtifacts,
    expiredCronLeases: cronHealth.cronLeaseQueryFailed ? null : cronHealth.expiredCronLeases,
    orphanedCronProgressRows: artifactsUnavailable ? null : cronHealth.orphanedCronProgressRows,
    scheduledSlotRunning: cronHealth.scheduledSlots.queryFailed ? null : cronHealth.scheduledSlots.runningSlots,
    scheduledSlotStaleCandidates: cronHealth.scheduledSlots.queryFailed ? null : cronHealth.scheduledSlots.staleCandidateSlots,
    scheduledSlotOldestRunningAgeSec: cronHealth.scheduledSlots.queryFailed ? null : cronHealth.scheduledSlots.oldestRunningAgeSec,
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
