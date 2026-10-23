import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { resolveScheduledSlotPolicy } from "../../../lib/scheduled-slot-policy";
import { confirmedCronOutputAt } from "../../../lib/cron-output";
import { makeLiveReserveCheckpoint } from "../../../lib/__tests__/scheduled-recovery-checkpoint.test-support";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  prepare: vi.fn(),
  retire: vi.fn(),
  release: vi.fn(),
  sweep: vi.fn(),
  runReserveSlot: vi.fn(),
  createRuntime: vi.fn(),
  configRecovery: vi.fn(),
  priority: vi.fn(),
  currentSlot: null as null | { reason: "current-slot-never-delivered"; slotStartedAt: number; graceSec: number },
  catchUpDetection: vi.fn(),
  reserveSlotInitialized: false,
  configRecoveryInitialized: false,
}));

vi.mock("../../../lib/scheduled-recovery-checkpoint", () => ({
  claimNextLiveReserveCheckpointRecovery: mocks.claim,
  prepareEligibleLiveReserveCheckpointRecoveries: mocks.prepare,
  retireSupersededLiveReserveCheckpoints: mocks.retire,
  releaseUnstartedLiveReserveRecoveryClaim: mocks.release,
}));
vi.mock("../../../lib/reserve-continuation-reconciliation", () => ({
  reconcileReserveContinuations: vi.fn(async () => 0),
}));
vi.mock("../../../lib/scheduled-slot-fence", () => ({
  sweepStaleScheduledSlotExecutions: mocks.sweep,
}));
vi.mock("../../../lib/scheduled-slot-catch-up", () => ({
  runSlotCatchUpDetection: mocks.catchUpDetection,
}));
vi.mock("../four-hourly-reserves", () => {
  mocks.reserveSlotInitialized = true;
  return { runFourHourlyReserveSyncSlot: mocks.runReserveSlot };
});
vi.mock("../context", () => ({
  createScheduledRuntimeContext: mocks.createRuntime,
}));
vi.mock("../../../cron/reserve-recovery-config", () => {
  mocks.configRecoveryInitialized = true;
  return { recoverLiveReserveConfigChanges: mocks.configRecovery };
});
vi.mock("../../../lib/reserve-producer-priority", async (importOriginal) => ({
  ...await importOriginal(),
  getReserveProducerPriority: mocks.priority,
  resolveReserveProducerAdmission: async (...args: unknown[]) => ({
    priority: await mocks.priority(...args), currentSlot: mocks.currentSlot,
  }),
}));

import { runFiveMinuteReserveRecoverySlot } from "../reserve-recovery";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";

const EMPTY_INSPECTION = {
  observedAt: 1_000,
  staleBefore: 880,
  readyCheckpointCount: 0,
  incompatibleCheckpointCount: 0,
  eligibleCheckpointCount: 0,
  candidates: [],
};

let latestLeasedResult: CronResult | void;
const reportProgress = vi.fn();

function runtime(mode: string | undefined): ScheduledRuntimeContext {
  const value = makeScheduledRuntime({
    db: {} as D1Database,
    env: { WORKER_RESERVE_RECOVERY_MODE: mode } as ScheduledRuntimeContext["env"],
    cron: "* * * * *",
    scheduleKey: "fiveMinuteReserveRecovery",
    scheduledTimeMs: 960_000,
    slotStartedAt: 960,
    invocationId: "recovery-poll",
    executionFence: {
      scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: 960, invocationId: "recovery-poll",
      owner: "executing-owner", generation: 7, workerRole: "public",
    },
    runLeasedCron: vi.fn(async (
      _job: string,
      fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
    ) => {
      latestLeasedResult = await fn(new AbortController().signal, reportProgress);
      return latestLeasedResult;
    }),
  });
  mocks.createRuntime.mockReturnValue(value);
  return value;
}

describe("reserve recovery mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestLeasedResult = undefined;
    mocks.currentSlot = null;
    mocks.configRecovery.mockResolvedValue({ attempted: [], healed: [], failed: [] });
    mocks.sweep.mockResolvedValue({ slotsReconciled: 0 });
    mocks.prepare.mockResolvedValue({ inspection: EMPTY_INSPECTION, prepared: [] });
    mocks.retire.mockResolvedValue(0);
    mocks.claim.mockResolvedValue({ disposition: "none" });
    mocks.release.mockReset().mockResolvedValue({ disposition: "released" });
    mocks.priority.mockReset().mockResolvedValue(null);
    mocks.runReserveSlot.mockResolvedValue({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0, jobs: [] });
  });
  it("keeps disabled and config-only polls outside the heavy checkpoint replay import graph", async () => {
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecoveryInitialized).toBe(false);
    await runFiveMinuteReserveRecoverySlot(runtime("off"));
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecoveryInitialized).toBe(false);
    mocks.priority.mockResolvedValueOnce({
      reason: "same-role-slot-co-tenancy", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 900,
      observedAt: 1000, lookaheadSec: 1440, condition: "same-role-slot-running",
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "ok" });
    expect(mocks.configRecoveryInitialized).toBe(false);
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();

    const fastPoll = runtime("recover");
    fastPoll.slotStartedAt = 1020;
    await runFiveMinuteReserveRecoverySlot(fastPoll);
    expect(mocks.configRecoveryInitialized).toBe(false);
    expect(mocks.reserveSlotInitialized).toBe(false);

    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(mocks.configRecoveryInitialized).toBe(true);
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.runReserveSlot).not.toHaveBeenCalled();
  });

  it("replays past a never-delivered current reserve slot and records why", async () => {
    mocks.currentSlot = { reason: "current-slot-never-delivered", slotStartedAt: 900, graceSec: 600 };
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint() });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(1);
    expect(JSON.parse((latestLeasedResult as { metadata?: string }).metadata ?? "{}")).toMatchObject({
      disposition: "recovery-executed",
      currentSlot: { reason: "current-slot-never-delivered", slotStartedAt: 900, graceSec: 600 },
    });
  });

  it.each([0, 2, 3, 4, 5, 7, 8, 9, 10])("keeps config recovery off intervening minute %s", async (minute) => {
    const value = runtime("recover");
    value.slotStartedAt = minute * 60;
    await runFiveMinuteReserveRecoverySlot(value);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(mocks.runReserveSlot).not.toHaveBeenCalled();
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      disposition: "no-recovery-due", configRecovery: { disposition: "not-due" },
    });
  });

  it.each([1, 6, 11, 56, 61])("retains config opportunity at scheduled minute %s despite delayed delivery", async (minute) => {
    const value = runtime("recover");
    value.slotStartedAt = minute * 60;
    await runFiveMinuteReserveRecoverySlot(value);
    expect(mocks.configRecovery).toHaveBeenCalledTimes(1);
  });

  describe.each(["preflight", "config", "claim", "post-claim", "child-summary"])("priority during %s", (phase) => {
    it.each([
      ["next-slot-lookahead", "producer-slot-priority", "ok"],
      ["same-role-slot-running", "same-role-slot-co-tenancy", "ok"],
      ["producer-slot-live", "producer-slot-live", "ok"],
      ["current-slot-unfinished", "producer-slot-priority", "skipped_neutral"],
    ])("reports %s as %s/%s without admitting more work", async (condition, reason, status) => {
      const priority = {
        reason: condition === "producer-slot-live" ? "producer-slot-priority" : reason,
        condition, scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: 900, observedAt: 1000, lookaheadSec: 1440,
      };
      if (phase === "preflight") mocks.priority.mockResolvedValueOnce(priority);
      else if (phase === "config") mocks.configRecovery.mockResolvedValue({ attempted: [], healed: [], failed: [], producerPriority: priority });
      else if (phase === "claim") mocks.claim.mockResolvedValue({ disposition: "priority", producerPriority: priority });
      else {
        mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
          state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
        }) });
        mocks.priority.mockResolvedValueOnce(null);
        if (phase === "post-claim") mocks.priority.mockResolvedValueOnce(priority);
        else {
          mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce(priority);
          mocks.runReserveSlot.mockResolvedValue({
            jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 1,
            jobs: [{ job: "sync-live-reserves", status: "skipped_neutral", reason: priority.reason }],
          });
        }
      }
      await runFiveMinuteReserveRecoverySlot(runtime("recover"));
      expect(latestLeasedResult).toMatchObject({ status });
      expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({ reason, producerPriority: priority });
      expect(confirmedCronOutputAt(latestLeasedResult, JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}"), 1000)).toBeNull();
      expect(mocks.runReserveSlot).toHaveBeenCalledTimes(phase === "child-summary" ? 1 : 0);
      if (phase === "preflight") expect(mocks.configRecovery).not.toHaveBeenCalled();
      if (phase === "preflight") expect(mocks.claim).not.toHaveBeenCalled();
      if (phase === "post-claim") expect(mocks.release).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps Oct-13 delivered-but-no-claim polls neutral without claiming work", async () => {
    mocks.priority.mockResolvedValue({
      reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1791907860,
      observedAt: 1791908204, lookaheadSec: 1440, condition: "current-slot-unfinished",
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "skipped_neutral", itemCount: 0 });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: "producer-slot-priority", attemptedCount: 0, checkpointsClaimed: 0,
    });
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("does not turn a failed priority read into a successful poll", async () => {
    mocks.priority.mockRejectedValue(new Error("producer-slot-read-failed"));
    const summary = await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(summary.jobsErrored).toBe(1);
    expect(latestLeasedResult).toBeUndefined();
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it.each([null, "current-slot-unfinished"])("does not renew waiting after live proof disappears: %s", async (condition) => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
      state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
    }) });
    mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce(condition ? {
        reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
        observedAt: 1100, lookaheadSec: 1440, condition,
      } : null);
    mocks.runReserveSlot.mockResolvedValue({
      jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 1,
      jobs: [{ job: "sync-live-reserves", status: "skipped_neutral", reason: "producer-slot-priority" }],
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "skipped_neutral" });
    const metadata = JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}");
    expect(metadata.reason).toBe("producer-slot-priority");
    expect(confirmedCronOutputAt(latestLeasedResult, metadata, 1100)).toBeNull();
  });


  it.each([true, false])("forwards native capability into targeted recovery only when admitted: %s", async admitted => {
    const value = runtime("recover");
    const capability = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    value.dwellirNative = capability;
    await runFiveMinuteReserveRecoverySlot(value);
    expect(mocks.configRecovery.mock.calls[0]?.[2]?.dwellirNative).toBe(capability);
  });

  it("runs bounded catch-up detection before reserve work, even when reserve recovery is off", async () => {
    const order: string[] = [];
    mocks.catchUpDetection.mockImplementation(async () => { order.push("detect"); });
    const value = runtime("off");
    vi.mocked(value.runLeasedCron).mockImplementationOnce(async () => { order.push("reserve"); });
    await runFiveMinuteReserveRecoverySlot(value);

    expect(order).toEqual(["detect", "reserve"]);
    expect(mocks.catchUpDetection).toHaveBeenCalledExactlyOnceWith(value.env, {
      host: "minute-lane", invocationId: "recovery-poll", signal: expect.any(AbortSignal), reconcileStale: true,
    });
  });

  it("does not run the global sweep on disabled reserve polls", async () => {
    const result = await runFiveMinuteReserveRecoverySlot(runtime("off"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.configRecovery).not.toHaveBeenCalled();
  });

  it("treats removed rollout modes as disabled", async () => {
    const result = await runFiveMinuteReserveRecoverySlot(runtime("shadow"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
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
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint });

    const value = runtime("recover");
    const result = await runFiveMinuteReserveRecoverySlot(value);

    expect(result.jobsErrored).toBe(0);
    expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), {
      owner: "recovery-poll",
      leaseSec: 900,
    });
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntime).toHaveBeenCalledWith(value.env, value.ctx, expect.objectContaining({
      slotStartedAt: checkpoint.slotStartedAt,
      executionFence: value.executionFence,
      deadline: value.deadline,
      slotBudgetStartedAtMs: value.deadline.eventEntryMs,
      jobAttemptNo: checkpoint.attemptNo,
    }));
    expect(mocks.createRuntime.mock.calls[0]![2].deadline).toBe(value.deadline);
    expect(mocks.createRuntime.mock.calls[0]![2].executionFence).toBe(value.executionFence);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.sweep.mock.calls[0]![1]).toMatchObject({ slotKey: "fourHourlyReserveSync", limit: 1 });
    expect(mocks.sweep.mock.calls[0]![1]).not.toHaveProperty("staleAfterSec");
    expect(mocks.prepare).toHaveBeenCalledWith(value.db, {
      staleAfterSec: resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec, limit: 1,
    });
    expect(reportProgress.mock.calls.map(([update]) => update.stage)).toEqual([
      "preparing-reserve-checkpoint",
      "replaying-reserve-checkpoint",
    ]);
    expect(JSON.parse((latestLeasedResult as { metadata?: string }).metadata ?? "{}")).toMatchObject({
      disposition: "recovery-executed",
      mode: "recover",
      retiredCheckpoints: 0,
      checkpointsClaimed: 1,
      originalScheduleKey: "fourHourlyReserveSync",
      originalSlotStartedAt: 800,
      recoveryAttemptNo: 2,
      executionGeneration: 2,
      sourceAttemptNo: 1,
      childDispositionsAtClaim: {},
      sweep: { slotsReconciled: 0 },
      preparation: { inspection: EMPTY_INSPECTION, prepared: [] },
      summary: { jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0, jobs: [] },
    });
  });

  it.each(["released", "not-owned", "already-started"])(
    "defers after a successful claim and reports the actual release disposition (%s)",
    async (disposition) => {
      const checkpoint = makeLiveReserveCheckpoint({
        state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
        currentItemKey: null, currentDomainAttemptId: "abandoned-domain-attempt",
      });
      mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint });
      const priority = {
        reason: "same-role-slot-co-tenancy", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 900,
        observedAt: 1000, lookaheadSec: 1440, condition: "same-role-slot-running",
      };
      mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce(priority);
      let completeRelease!: () => void;
      let releaseStarted!: () => void;
      const gate = new Promise<void>((resolve) => { completeRelease = resolve; });
      const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
      mocks.release.mockImplementationOnce(async () => {
        releaseStarted();
        await gate;
        return { disposition };
      });
      const value = runtime("recover");
      let settled = false;
      const pending = runFiveMinuteReserveRecoverySlot(value).then((result) => {
        settled = true;
        return result;
      });
      try {
        await started;
        expect(settled).toBe(false);
        expect(mocks.runReserveSlot).not.toHaveBeenCalled();
        expect(latestLeasedResult).toBeUndefined();
      } finally {
        completeRelease();
        await pending;
      }
      expect(latestLeasedResult).toMatchObject({ status: "ok" });
      expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
        checkpointsClaimed: 1, producerPriority: priority, recoveryClaimRelease: { disposition },
      });
      expect(mocks.runReserveSlot).not.toHaveBeenCalled();
    },
  );

  it.each(["current-slot-unfinished", "next-slot-lookahead", "producer-slot-live"])("keeps config repair outside a claimed cohort's budget when %s defers it", async (condition) => {
    mocks.configRecovery.mockResolvedValue({ attempted: ["coin"], healed: [], failed: ["coin"] });
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
      state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
    }) });
    mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce({
      reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
      observedAt: 1000, lookaheadSec: 1440, condition,
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: condition === "current-slot-unfinished" ? "skipped_neutral" : "ok" });
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: condition === "producer-slot-live" ? "producer-slot-live" : "producer-slot-priority",
      recoveryClaimRelease: { disposition: "released" },
    });
    expect(mocks.runReserveSlot).not.toHaveBeenCalled();
  });

  it("persists the config phase before initializing or executing its heavy graph", async () => {
    mocks.configRecovery.mockImplementation(async () => {
      expect(reportProgress).toHaveBeenLastCalledWith({ stage: "recovering-reserve-config" });
      throw new Error("config recovery failed");
    });
    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(result.jobsErrored).toBe(1);
    expect(reportProgress.mock.calls.map(([update]) => update.stage)).toEqual([
      "preparing-reserve-checkpoint", "recovering-reserve-config",
    ]);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it("keeps historical incompatible checkpoint debt in telemetry on a successful idle poll", async () => {
    mocks.prepare.mockResolvedValue({
      inspection: { ...EMPTY_INSPECTION, incompatibleCheckpointCount: 14 },
      prepared: [],
    });
    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(result.jobsDegraded).toBe(0);
    expect(latestLeasedResult).toMatchObject({ status: "ok" });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      statusCause: "reserve-recovery-zero-eligible-incompatible", checkpointsClaimed: 0,
    });
  });

  it.each([
    [0, 0, false, "skipped_neutral"],
    [1, 0, true, "error"],
    [0, 1, true, "degraded"],
  ])("keeps unproven waiting or failed child work visible (%s/%s/%s)", async (errors, degraded, observedPriority, status) => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
      state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
    }) });
    mocks.runReserveSlot.mockResolvedValue({
      jobsErrored: errors, jobsDegraded: degraded, jobsSkipped: 1,
      jobs: [{ job: "sync-live-reserves", status: "skipped_neutral", reason: "producer-slot-priority" }],
    });
    if (observedPriority) mocks.priority.mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null).mockResolvedValueOnce({
        reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
        observedAt: 1000, lookaheadSec: 1440, condition: "next-slot-lookahead",
      });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: errors ? "reserve-replay-child-error" : degraded ? "reserve-replay-child-degraded" : "producer-slot-priority",
    });
  });

  it("prioritizes checkpoint continuation over targeted config repair", async () => {
    mocks.configRecovery.mockResolvedValue({ disposition: "config-recovery-checked", attempted: ["usdt-tether"], healed: [], failed: ["usdt-tether"], deferredCount: 0 });
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
      scheduleKey: "fourHourlyReserveSync", slotStartedAt: 800,
      attemptNo: 2, executionGeneration: 2, sourceAttemptNo: 1, childDispositions: {},
    } });
    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(result.jobsDegraded).toBe(0);
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(1);
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      disposition: "recovery-executed", checkpointsClaimed: 1,
      configRecovery: { disposition: "deferred-for-cohort" },
    });
    expect(mocks.configRecovery).not.toHaveBeenCalled();
  });

  it("reports capacity deferral but not producer-lease contention as degraded", async () => {
    mocks.configRecovery.mockResolvedValue({ attempted: [], healed: [], failed: [], deferredCount: 2 });
    expect((await runFiveMinuteReserveRecoverySlot(runtime("recover"))).jobsDegraded).toBe(1);
    mocks.configRecovery.mockResolvedValue({
      disposition: "config-recovery-skipped", reason: "sync-live-reserves-lease-held",
      attempted: [], healed: [], failed: [],
    });
    expect((await runFiveMinuteReserveRecoverySlot(runtime("recover"))).jobsDegraded).toBe(0);
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      configRecovery: { disposition: "config-recovery-skipped", reason: "sync-live-reserves-lease-held" },
    });
  });

  it.each([false, true])("surfaces a missing-fetcher warning without suppressing available checkpoint replay (%s)", async (hasCheckpoint) => {
    const warnings = [{ stablecoinId: "uncovered", code: "config-recovery-missing-fetcher", severity: "warning" }];
    mocks.configRecovery.mockResolvedValue({
      disposition: "config-recovery-partial", missingFetcherCount: 1,
      attempted: ["covered"], healed: ["covered"], failed: [], deferredCount: 0, warnings,
    });
    if (hasCheckpoint) {
      mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
        scheduleKey: "fourHourlyReserveSync", slotStartedAt: 800,
        attemptNo: 2, executionGeneration: 2, sourceAttemptNo: 1, childDispositions: {},
      } });
    }
    expect((await runFiveMinuteReserveRecoverySlot(runtime("recover"))).jobsDegraded).toBe(hasCheckpoint ? 0 : 1);
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      checkpointsClaimed: hasCheckpoint ? 1 : 0,
      configRecovery: hasCheckpoint ? { disposition: "deferred-for-cohort" }
        : { disposition: "config-recovery-partial", healed: ["covered"], warnings },
    });
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(hasCheckpoint ? 1 : 0);
  });
  it.each([
    [1, 1, 1, "reserve-replay-child-error", "error"],
    [0, 1, 1, "reserve-replay-child-degraded", "degraded"],
    [0, 0, 1, "reserve-replay-deferred", "degraded"],
  ])("names the primary reason with child precedence (%s/%s/%s)", async (errors, degraded, skipped, reason, status) => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
      scheduleKey: "fourHourlyReserveSync", slotStartedAt: 800, attemptNo: 2,
      executionGeneration: 2, sourceAttemptNo: 1, childDispositions: {},
    } });
    mocks.configRecovery.mockResolvedValue({
      attempted: ["coin"], healed: [], failed: ["coin"], missingFetcherCount: 1, deferredCount: 1,
    });
    mocks.runReserveSlot.mockResolvedValue({ jobsErrored: errors, jobsDegraded: degraded, jobsSkipped: skipped, jobs: [] });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason, reasons: expect.arrayContaining([reason]),
      configRecovery: { disposition: "deferred-for-cohort" },
    });
  });

  it.each(["current-slot-unfinished", "next-slot-lookahead", "producer-slot-live"])("does not erase a config failure when %s appears before replay", async (condition) => {
    mocks.configRecovery.mockResolvedValue({ attempted: ["coin"], healed: [], failed: ["coin"] });
    mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce({
      reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
      observedAt: 1000, lookaheadSec: 1440, condition,
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "degraded" });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: "reserve-config-recovery-failed",
      reasons: ["reserve-config-recovery-failed", condition === "producer-slot-live" ? "producer-slot-live" : "producer-slot-priority"],
    });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it("reports bounded cohort continuation as normal work, not recovery degradation", async () => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
      state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
    }) });
    mocks.runReserveSlot.mockResolvedValue({
      jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0, jobsNeutralSkipped: 2,
      jobs: ["sync-redemption-backstops", "cron-sentinel"].map((job) => ({
        job, status: "skipped_neutral", reason: "reserve-cohort-continuation",
      })),
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "ok", itemCount: 1 });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      disposition: "cohort-continuation", continuationPending: true, reasons: [],
    });
    expect(mocks.configRecovery).not.toHaveBeenCalled();
  });
});
