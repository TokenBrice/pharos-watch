import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { resolveScheduledSlotPolicy } from "../../../lib/scheduled-slot-policy";
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
  reserveSlotInitialized: false,
  configRecoveryInitialized: false,
}));

vi.mock("../../../lib/scheduled-recovery-checkpoint", () => ({
  claimNextLiveReserveCheckpointRecovery: mocks.claim,
  prepareEligibleLiveReserveCheckpointRecoveries: mocks.prepare,
  retireSupersededLiveReserveCheckpoints: mocks.retire,
  releaseUnstartedLiveReserveRecoveryClaim: mocks.release,
}));
vi.mock("../../../lib/scheduled-slot-fence", () => ({
  sweepStaleScheduledSlotExecutions: mocks.sweep,
}));
vi.mock("../hourly-live-reserves", () => {
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
    cron: "1,6,11,16,21,26,31,36,41,46,51,56 * * * *",
    scheduleKey: "fiveMinuteReserveRecovery",
    scheduledTimeMs: 1_000_000,
    slotStartedAt: 1_000,
    invocationId: "recovery-poll",
    executionFence: {
      scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: 1_000, invocationId: "recovery-poll",
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
    mocks.configRecovery.mockResolvedValue({ attempted: [], healed: [], failed: [] });
    mocks.sweep.mockResolvedValue({ slotsReconciled: 0 });
    mocks.prepare.mockResolvedValue({ inspection: EMPTY_INSPECTION, prepared: [] });
    mocks.retire.mockResolvedValue(0);
    mocks.claim.mockResolvedValue({ disposition: "none" });
    mocks.release.mockReset().mockResolvedValue({ disposition: "released" });
    mocks.priority.mockReset().mockResolvedValue(null);
    mocks.runReserveSlot.mockResolvedValue({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
  });
  it("keeps disabled and config-only polls outside the heavy checkpoint replay import graph", async () => {
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecoveryInitialized).toBe(false);
    await runFiveMinuteReserveRecoverySlot(runtime("off"));
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecoveryInitialized).toBe(false);
    mocks.priority.mockResolvedValueOnce({
      reason: "heavy-slot-co-tenancy", scheduleKey: "halfHourlyChartsOffset", slotStartedAt: 900,
      observedAt: 1000, lookaheadSec: 1440, condition: "heavy-slot-running",
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "skipped_neutral" });
    expect(mocks.configRecoveryInitialized).toBe(false);
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.configRecovery).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.sweep).toHaveBeenCalledTimes(2);

    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(mocks.configRecoveryInitialized).toBe(true);
    expect(mocks.reserveSlotInitialized).toBe(false);
    expect(mocks.runReserveSlot).not.toHaveBeenCalled();
  });


  it.each([true, false])("forwards native capability into targeted recovery only when admitted: %s", async admitted => {
    const value = runtime("recover");
    const capability = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    value.dwellirNative = capability;
    await runFiveMinuteReserveRecoverySlot(value);
    expect(mocks.configRecovery.mock.calls[0]?.[2]?.dwellirNative).toBe(capability);
  });

  it("runs only the global stale-slot sweep when off", async () => {
    const result = await runFiveMinuteReserveRecoverySlot(runtime("off"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.sweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10 }),
    );
    expect(mocks.sweep.mock.calls[0]![1]).not.toHaveProperty("slotKey");
    expect(mocks.sweep.mock.calls[0]![1]).not.toHaveProperty("staleAfterSec");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.configRecovery).not.toHaveBeenCalled();
  });

  it("treats removed rollout modes as disabled", async () => {
    const result = await runFiveMinuteReserveRecoverySlot(runtime("shadow"));

    expect(result.jobsErrored).toBe(0);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
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
    expect(mocks.sweep.mock.calls[1]![1]).not.toHaveProperty("staleAfterSec");
    expect(mocks.prepare).toHaveBeenCalledWith(value.db, {
      staleAfterSec: resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec, limit: 1,
    });
    expect(reportProgress.mock.calls.map(([update]) => update.stage)).toEqual([
      "sweeping-stale-slots",
      "recovering-reserve-config",
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
      summary: { jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 },
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
        reason: "heavy-slot-co-tenancy", scheduleKey: "halfHourlyChartsOffset", slotStartedAt: 900,
        observedAt: 1000, lookaheadSec: 1440, condition: "heavy-slot-running",
      };
      mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(priority);
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
      expect(latestLeasedResult).toMatchObject({ status: "skipped_neutral" });
      expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
        checkpointsClaimed: 1, producerPriority: priority, recoveryClaimRelease: { disposition },
      });
      expect(mocks.runReserveSlot).not.toHaveBeenCalled();
    },
  );

  it("preserves config degradation when priority defers an owned claim", async () => {
    mocks.configRecovery.mockResolvedValue({ attempted: ["coin"], healed: [], failed: ["coin"] });
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: makeLiveReserveCheckpoint({
      state: "recovering", invocationId: "recovery-poll", recoveryOwner: "recovery-poll",
    }) });
    mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({
      reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
      observedAt: 1000, lookaheadSec: 1440, condition: "current-slot-unfinished",
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "degraded" });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: "reserve-config-recovery-failed", recoveryClaimRelease: { disposition: "released" },
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
      "sweeping-stale-slots", "recovering-reserve-config",
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
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

  it("reports a contended recovery as degraded so the active checkpoint can retry", async () => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 800,
      attemptNo: 2,
      executionGeneration: 2,
      sourceAttemptNo: 1,
      childDispositions: {},
    } });
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

  it("preserves checkpoint replay when targeted config recovery fails", async () => {
    mocks.configRecovery.mockResolvedValue({ disposition: "config-recovery-checked", attempted: ["usdt-tether"], healed: [], failed: ["usdt-tether"], deferredCount: 0 });
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
      scheduleKey: "fourHourlyReserveSync", slotStartedAt: 800,
      attemptNo: 2, executionGeneration: 2, sourceAttemptNo: 1, childDispositions: {},
    } });
    const result = await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(result.jobsDegraded).toBe(1);
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(1);
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      disposition: "recovery-executed", checkpointsClaimed: 1,
      configRecovery: { failed: ["usdt-tether"], healed: [] },
    });
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
    expect((await runFiveMinuteReserveRecoverySlot(runtime("recover"))).jobsDegraded).toBe(1);
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      checkpointsClaimed: hasCheckpoint ? 1 : 0,
      configRecovery: { disposition: "config-recovery-partial", healed: ["covered"], warnings },
    });
    expect(mocks.runReserveSlot).toHaveBeenCalledTimes(hasCheckpoint ? 1 : 0);
  });
  it.each([
    [1, 1, 1, "reserve-replay-child-error", "error"],
    [0, 1, 1, "reserve-replay-child-degraded", "degraded"],
    [0, 0, 1, "reserve-replay-deferred", "degraded"],
    [0, 0, 0, "reserve-config-recovery-failed", "degraded"],
  ])("names the primary reason with child precedence (%s/%s/%s)", async (errors, degraded, skipped, reason, status) => {
    mocks.claim.mockResolvedValue({ disposition: "claimed", checkpoint: {
      scheduleKey: "fourHourlyReserveSync", slotStartedAt: 800, attemptNo: 2,
      executionGeneration: 2, sourceAttemptNo: 1, childDispositions: {},
    } });
    mocks.configRecovery.mockResolvedValue({
      attempted: ["coin"], healed: [], failed: ["coin"], missingFetcherCount: 1, deferredCount: 1,
    });
    mocks.runReserveSlot.mockResolvedValue({ jobsErrored: errors, jobsDegraded: degraded, jobsSkipped: skipped });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason, reasons: expect.arrayContaining([
        "reserve-config-recovery-failed", "reserve-config-recovery-missing-fetcher", "reserve-config-recovery-deferred",
      ]), configRecovery: { failed: ["coin"] },
    });
  });

  it("does not erase a config failure when producer priority appears before replay", async () => {
    mocks.configRecovery.mockResolvedValue({ attempted: ["coin"], healed: [], failed: ["coin"] });
    mocks.priority.mockResolvedValueOnce(null).mockResolvedValueOnce({
      reason: "producer-slot-priority", scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000,
      observedAt: 1000, lookaheadSec: 1440, condition: "current-slot-unfinished",
    });
    await runFiveMinuteReserveRecoverySlot(runtime("recover"));
    expect(latestLeasedResult).toMatchObject({ status: "degraded" });
    expect(JSON.parse((latestLeasedResult as CronResult).metadata ?? "{}")).toMatchObject({
      reason: "reserve-config-recovery-failed", reasons: ["reserve-config-recovery-failed", "producer-slot-priority"],
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
