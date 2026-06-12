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
    diagnosticIssueCount: 0,
    worstCacheRatio: 0,
    transitionsLast24h: 0,
  };
}

export function buildStatusSummary(input: {
  cronHealth: CronHealthSnapshot;
  diagnosticIssueCount: number;
  worstCacheRatio: number;
  transitionsLast24h: number;
}): StatusSummary {
  const { cronHealth } = input;
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
    diagnosticIssueCount: input.diagnosticIssueCount,
    worstCacheRatio: input.worstCacheRatio,
    transitionsLast24h: input.transitionsLast24h,
  };
}
