import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
  sweep: vi.fn(),
  runReserveSlot: vi.fn(),
  createRuntime: vi.fn(),
}));

vi.mock("../../../lib/scheduled-recovery-checkpoint", () => ({
  claimNextScheduledCheckpointRecovery: mocks.claim,
  inspectScheduledCheckpointRecoveryEligibility: mocks.inspect,
  prepareEligibleScheduledCheckpointRecoveries: mocks.prepare,
}));
vi.mock("../../../lib/scheduled-slot-fence", () => ({
  sweepStaleScheduledSlotExecutions: mocks.sweep,
}));
vi.mock("../hourly-live-reserves", () => ({
  LIVE_RESERVE_SLOT_JOBS: [
    "sync-live-reserves",
    "sync-redemption-backstops",
    "sync-kinesis-supply",
    "reserve-post-sync-watchdog",
  ],
  runFourHourlyReserveSyncSlot: mocks.runReserveSlot,
}));
vi.mock("../context", () => ({
  createScheduledRuntimeContext: mocks.createRuntime,
}));

import { runFiveMinuteReserveRecoverySlot } from "../reserve-recovery";

const EMPTY_INSPECTION = {
  observedAt: 1_000,
  staleBefore: 880,
  readyCheckpointCount: 0,
  eligibleCheckpointCount: 0,
  candidates: [],
};

function runtime(mode: string | undefined): ScheduledRuntimeContext {
  const value = {
    db: {} as D1Database,
    env: { WORKER_RESERVE_RECOVERY_MODE: mode } as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "1,6,11,16,21,26,31,36,41,46,51,56 * * * *",
    scheduleKey: "fiveMinuteReserveRecovery",
    scheduledTimeMs: 1_000_000,
    slotStartedAt: 1_000,
    invocationId: "recovery-poll",
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    alertWebhookUrl: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (_job, fn) => fn(new AbortController().signal, vi.fn())),
  } as ScheduledRuntimeContext;
  mocks.createRuntime.mockReturnValue(value);
  return value;
}

describe("reserve recovery mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue(EMPTY_INSPECTION);
    mocks.sweep.mockResolvedValue({ slotsReconciled: 0 });
    mocks.prepare.mockResolvedValue({ inspection: EMPTY_INSPECTION, prepared: [] });
    mocks.claim.mockResolvedValue(null);
    mocks.runReserveSlot.mockResolvedValue({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
  });

  it("does not scan, reconcile, or claim when off", async () => {
    const result = await runFiveMinuteReserveRecoverySlot(runtime("off"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("keeps shadow mode read-only while reporting eligibility", async () => {
    mocks.inspect.mockResolvedValue({
      ...EMPTY_INSPECTION,
      eligibleCheckpointCount: 1,
      candidates: [{ eligible: true, blockers: [] }],
    });

    const result = await runFiveMinuteReserveRecoverySlot(runtime("shadow"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("prepares abandoned attempts in reconcile mode without claiming", async () => {
    mocks.prepare.mockResolvedValue({
      inspection: EMPTY_INSPECTION,
      prepared: [{ abandonedAttemptNo: 1, recoveryAttemptNo: 2 }],
    });

    const result = await runFiveMinuteReserveRecoverySlot(runtime("reconcile"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runReserveSlot).not.toHaveBeenCalled();
  });

  it("claims and replays only in recover mode", async () => {
    const checkpoint = {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 800,
      attemptNo: 2,
      executionGeneration: 2,
      sourceAttemptNo: 1,
      childDispositions: {},
    };
    mocks.claim.mockResolvedValue(checkpoint);

    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      expectedQueueHash: expect.any(String),
    }));
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(1);
  });

  it("reports a contended recovery as degraded so the active checkpoint can retry", async () => {
    mocks.claim.mockResolvedValue({
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 800,
      attemptNo: 2,
      executionGeneration: 2,
      sourceAttemptNo: 1,
      childDispositions: {},
    });
    mocks.runReserveSlot.mockResolvedValue({
      jobsErrored: 0,
      jobsDegraded: 0,
      jobsSkipped: 1,
    });

    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));

    expect(result).toMatchObject({
      jobsDegraded: 1,
      jobsErrored: 0,
      jobs: [expect.objectContaining({
        job: "reserve-recovery",
        outcome: "degraded",
        status: "degraded",
      })],
    });
  });
});
