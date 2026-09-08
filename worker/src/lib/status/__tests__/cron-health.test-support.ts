import type { CronHealthSnapshot } from "../cron-health";

export function makeCronHealth(
  overrides: Omit<Partial<CronHealthSnapshot>, "scheduledSlots"> & {
    scheduledSlots?: Partial<CronHealthSnapshot["scheduledSlots"]>;
  } = {},
): CronHealthSnapshot {
  return {
    crons: {},
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
