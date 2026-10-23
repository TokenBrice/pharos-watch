import type { CronHealthSnapshot } from "../cron-health";

export function makeCronHealth(
  overrides: Omit<Partial<CronHealthSnapshot>, "scheduledSlots"> & {
    scheduledSlots?: Partial<CronHealthSnapshot["scheduledSlots"]>;
  } = {},
): CronHealthSnapshot {
  return {
    crons: {},
    cronFindingJobs: {
      availabilityImpactingUnhealthy: [], watchUnhealthy: [], degraded: [],
      availabilityImpactingErrors: [], availabilityImpactingConsecutiveErrors: [], watchErrors: [],
    },
    unhealthyCrons: 0,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 0,
    degradedCronRuns: 0,
    cronErrorCount: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    staleCronArtifacts: 0,
    expiredCronLeases: 0,
    orphanedCronProgressRows: 0,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
    scheduledSlotEventMarkerQueryFailed: false,
    scheduledDeliveryLag: { startedSlots: 0, lateSlots: 0, maxLagSec: null, queryFailed: false },
    ...overrides,
    scheduledSlots: {
      runningSlots: 0,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: null,
      oldestStaleAgeSec: null,
      queryFailed: false,
      ...overrides.scheduledSlots,
    },
  };
}
