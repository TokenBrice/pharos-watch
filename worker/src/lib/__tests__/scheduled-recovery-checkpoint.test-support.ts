import type { ScheduledRecoveryCheckpoint } from "../scheduled-recovery-checkpoint";

/** Canonical running live-reserve checkpoint for scheduled-handler tests (WK-2 service). */
export function makeLiveReserveCheckpoint(
  overrides: Partial<ScheduledRecoveryCheckpoint> = {},
): ScheduledRecoveryCheckpoint {
  return {
    scheduleKey: "fourHourlyReserveSync",
    slotStartedAt: 0,
    job: "sync-live-reserves",
    attemptNo: 1,
    executionGeneration: 1,
    invocationId: "test-checkpoint",
    workerVersion: null,
    queueHash: "test",
    state: "running",
    nextItemKey: null,
    currentItemKey: null,
    currentDomainAttemptId: null,
    itemsDone: 0,
    itemsTotal: 0,
    childDispositions: {},
    recoveryOwner: null,
    recoveryLeaseUntil: null,
    sourceAttemptNo: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}
