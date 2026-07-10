import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { runFourHourlyReserveSyncSlot } from "../hourly-live-reserves";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/sync-live-reserves", () => ({
  syncLiveReserves: vi.fn(),
}));
vi.mock("../../../cron/sync-redemption-backstops", () => ({
  syncRedemptionBackstops: vi.fn(),
}));
vi.mock("../../../cron/sync-kinesis-supply", () => ({
  syncKinesisSupply: vi.fn(),
}));
vi.mock("../../../lib/collateral-drift", () => ({
  checkCollateralDrift: vi.fn(),
}));
vi.mock("../../../lib/live-reserves-store", () => ({
  getMaxSyncAge: vi.fn(),
  computeReserveCompositionOverview: vi.fn(),
}));
vi.mock("../../../lib/alert-broker", () => ({
  reportAlertCondition: vi.fn(async () => ({
    state: "recovered",
    transition: null,
    deliveryState: null,
  })),
}));
vi.mock("../../../lib/db-cache", () => ({
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => {}),
}));
vi.mock("../../../lib/scheduled-recovery-checkpoint", () => ({
  beginScheduledCheckpoint: vi.fn(async () => ({
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
  })),
  loadScheduledCheckpoint: vi.fn(),
  setScheduledCheckpointChildDisposition: vi.fn(async () => {}),
  finishScheduledCheckpoint: vi.fn(async () => {}),
}));
vi.mock("../../../lib/reserve-recovery-fault-injection", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/reserve-recovery-fault-injection")>();
  return {
    ...original,
    loadReserveRecoveryFaultInjectionController: vi.fn(async () => null),
  };
});
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));

import { syncLiveReserves } from "../../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../../lib/collateral-drift";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../../lib/live-reserves-store";
import { reportAlertCondition } from "../../../lib/alert-broker";
import { getCache, setCache } from "../../../lib/db-cache";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../../lib/alert-reserve-source-cache";
import { SNAPSHOT_KEYS } from "../../../cron/telegram-alert-snapshots";
import {
  loadReserveRecoveryFaultInjectionController,
  ReserveRecoveryFaultInjectionTermination,
  type ReserveRecoveryFaultKillPoint,
} from "../../../lib/reserve-recovery-fault-injection";
import {
  finishScheduledCheckpoint,
  loadScheduledCheckpoint,
  setScheduledCheckpointChildDisposition,
  type ScheduledRecoveryCheckpoint,
} from "../../../lib/scheduled-recovery-checkpoint";

describe("runFourHourlyReserveSyncSlot", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(syncLiveReserves).mockResolvedValue(undefined as never);
    vi.mocked(syncRedemptionBackstops).mockResolvedValue(undefined as never);
    vi.mocked(syncKinesisSupply).mockResolvedValue(undefined as never);
    vi.mocked(checkCollateralDrift).mockResolvedValue({
      driftCoins: [],
      fallbackCoins: [],
    } as never);
    vi.mocked(getMaxSyncAge).mockResolvedValue(0);
    vi.mocked(computeReserveCompositionOverview).mockResolvedValue({
      configuredCoins: 0,
      freshCoins: 0,
      staleCoins: 0,
      missingCoins: 0,
      degradedCoins: 0,
      errorCoins: 0,
      corruptCoins: 0,
      independentFreshEligible: 0,
      independentFreshUnverified: 0,
      staticValidatedFresh: 0,
      weakProbeFresh: 0,
      writeTimeoutUncertain: 0,
      deferredCoins: 0,
      runBudgetTruncated: false,
      deferredAt: null,
      nextCursorStablecoinId: null,
      cursorTailState: null,
      cursorTailError: null,
      cursorRecordedAt: null,
      cursorTailCompletedAt: null,
      cursorTailFailedAt: null,
      runBudgetTruncationCount: 0,
      historyWriteGaps: [],
      persistentlyStaleIndependentCoins: [],
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
    });
    vi.mocked(loadReserveRecoveryFaultInjectionController).mockResolvedValue(null);
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(recoveryCheckpoint());
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runLeasedCron = vi.fn(async (_job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
      return fn(new AbortController().signal, async () => {});
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    errorSpy.mockRestore();
  });

  function buildRuntime(recoveryCheckpoint?: ScheduledRecoveryCheckpoint): ScheduledRuntimeContext {
    return {
      db: {} as D1Database,
      env: {} as ScheduledRuntimeContext["env"],
      ctx: {} as ExecutionContext,
      cron: "11 */4 * * *",
      scheduleKey: "fourHourlyReserveSync",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      mintBurnDisabledIds: [],
      mintBurnDisabledSymbols: [],
      mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
      coingeckoApiKey: null,
      alertWebhookUrl: null,
      chainRpcs: new Map(),
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
      ...(recoveryCheckpoint ? { recoveryCheckpoint } : {}),
    };
  }

  function recoveryCheckpoint(
    childDispositions: ScheduledRecoveryCheckpoint["childDispositions"] = {},
    attemptNo = 2,
  ): ScheduledRecoveryCheckpoint {
    return {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 0,
      job: "sync-live-reserves",
      attemptNo,
      executionGeneration: attemptNo,
      invocationId: `recovery-owner-${attemptNo}`,
      workerVersion: "preview-v1",
      queueHash: "test",
      state: "recovering",
      nextItemKey: null,
      currentItemKey: null,
      currentDomainAttemptId: null,
      itemsDone: 0,
      itemsTotal: 0,
      childDispositions,
      recoveryOwner: `recovery-owner-${attemptNo}`,
      recoveryLeaseUntil: 1_000,
      sourceAttemptNo: attemptNo - 1,
      error: null,
      createdAt: 0,
      updatedAt: 0,
      completedAt: null,
    };
  }

  it("keeps every sidecar pending when sync-live-reserves throws", async () => {
    vi.mocked(syncLiveReserves).mockRejectedValue(new Error("sync blew up"));
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue({
      ...recoveryCheckpoint(),
      nextItemKey: "unfinished-coin",
      itemsDone: 0,
      itemsTotal: 20,
    });

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 0,
      jobsErrored: 1,
      jobsSkipped: 3,
    });

    expect(syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Live reserves sync failed"),
      expect.any(Error),
    );
  });

  it("terminalizes an exhausted all-error queue without running stale sidecars", async () => {
    const exhaustedCheckpoint = {
      ...recoveryCheckpoint({}, 2),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({
      status: "error",
      error: "all reserve adapters failed",
    });

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(exhaustedCheckpoint));

    expect(summary).toMatchObject({ jobsErrored: 1, jobsSkipped: 3 });
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 2 }),
      {
        state: "failed",
        error: "live reserve queue exhausted without a successful result",
      },
    );
  });

  it("keeps later sidecars pending when redemption backstops throws", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValue(new Error("rb blew up"));
    vi.mocked(syncKinesisSupply).mockRejectedValue(new Error("ks blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 1,
      jobsErrored: 1,
      jobsSkipped: 2,
    });

    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redemption backstops sync failed"),
      expect.any(Error),
    );
  });

  it("swallows drift check errors and logs them", async () => {
    vi.mocked(checkCollateralDrift).mockRejectedValue(new Error("drift blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 3,
      jobsErrored: 0,
      jobsDegraded: 1,
      jobsSkipped: 0,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron-failure:reserve-post-sync-watchdog]"),
      expect.any(String),
    );
  });

  it("records healthy conditions so prior reserve incidents can recover", async () => {
    await runFourHourlyReserveSyncSlot(buildRuntime());

    expect(reportAlertCondition).toHaveBeenCalledTimes(3);
    expect(reportAlertCondition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      conditionKey: "reserve:collateral-score-drift",
      active: false,
    }));
    expect(reportAlertCondition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      conditionKey: "reserve:live-reserve-sync-stale",
      active: false,
    }));
  });

  it.each([
    "sync-live-reserves",
    "sync-redemption-backstops",
    "sync-kinesis-supply",
    "reserve-post-sync-watchdog",
  ] as const)("keeps a checkpoint recoverable when %s is lease-contended", async (contendedJob) => {
    runLeasedCron.mockImplementation(async (
      job: string,
      fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>,
    ) => {
      if (job === contendedJob) return { status: "skipped_locked" };
      return fn(new AbortController().signal, async () => {});
    });

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(summary.jobsSkipped).toBeGreaterThan(0);
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
    expect(vi.mocked(setScheduledCheckpointChildDisposition).mock.calls).not.toContainEqual([
      expect.anything(),
      expect.anything(),
      contendedJob,
      "completed",
    ]);
    const expectedJobsThroughContention = {
      "sync-live-reserves": ["sync-live-reserves"],
      "sync-redemption-backstops": ["sync-live-reserves", "sync-redemption-backstops"],
      "sync-kinesis-supply": [
        "sync-live-reserves",
        "sync-redemption-backstops",
        "sync-kinesis-supply",
      ],
      "reserve-post-sync-watchdog": [
        "sync-live-reserves",
        "sync-redemption-backstops",
        "sync-kinesis-supply",
        "reserve-post-sync-watchdog",
      ],
    } as const;
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(
      expectedJobsThroughContention[contendedJob],
    );
  });

  it("retries an unfinished sidecar without replaying completed checkpoint children", async () => {
    let redemptionContended = true;
    runLeasedCron.mockImplementation(async (
      job: string,
      fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>,
    ) => {
      if (job === "sync-redemption-backstops" && redemptionContended) {
        return { status: "skipped_locked" };
      }
      return fn(new AbortController().signal, async () => {});
    });

    const firstSummary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(firstSummary.jobsSkipped).toBe(3);
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();

    redemptionContended = false;
    runLeasedCron.mockClear();
    vi.mocked(finishScheduledCheckpoint).mockClear();
    const successor = recoveryCheckpoint({
      "sync-live-reserves": "completed",
      "sync-redemption-backstops": "not_started",
      "sync-kinesis-supply": "not_started",
      "reserve-post-sync-watchdog": "not_started",
    }, 3);
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(successor);

    const retrySummary = await runFourHourlyReserveSyncSlot(buildRuntime(successor));

    expect(retrySummary.jobsSkipped).toBe(0);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-redemption-backstops",
      "sync-kinesis-supply",
      "reserve-post-sync-watchdog",
    ]);
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("retries a failed sidecar and runs the watchdog only after the retry succeeds", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValueOnce(new Error("redemption failed"));

    const firstSummary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(firstSummary).toMatchObject({ jobsErrored: 1, jobsSkipped: 2 });
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();

    const successor = recoveryCheckpoint({
      "sync-live-reserves": "completed",
      "sync-redemption-backstops": "not_started",
      "sync-kinesis-supply": "not_started",
      "reserve-post-sync-watchdog": "not_started",
    }, 3);
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(successor);
    runLeasedCron.mockClear();

    const retrySummary = await runFourHourlyReserveSyncSlot(buildRuntime(successor));

    expect(retrySummary).toMatchObject({ jobsErrored: 0, jobsSkipped: 0 });
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-redemption-backstops",
      "sync-kinesis-supply",
      "reserve-post-sync-watchdog",
    ]);
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("resets a child to not_started when its body reports a lease skip", async () => {
    vi.mocked(syncKinesisSupply).mockResolvedValue({ status: "skipped_locked" } as never);

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(summary.jobsSkipped).toBe(2);
    expect(setScheduledCheckpointChildDisposition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "sync-kinesis-supply",
      "not_started",
    );
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
  });

  it("publishes a timestamped recovering reserve source after a missing producer generation", async () => {
    vi.mocked(checkCollateralDrift).mockResolvedValue({
      driftCoins: [{ id: "usdc-circle" }],
      fallbackCoins: [],
    } as never);
    vi.mocked(getCache).mockResolvedValue(null);

    await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(getCache).toHaveBeenCalledWith(expect.anything(), SNAPSHOT_KEYS.reserve);
    const reserveWrite = vi.mocked(setCache).mock.calls.find(([, key]) => key === SNAPSHOT_KEYS.reserve);
    expect(reserveWrite).toBeDefined();
    expect(JSON.parse(reserveWrite?.[2] as string)).toMatchObject({
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      continuous: false,
      driftIds: ["usdc-circle"],
      publishedAt: expect.any(Number),
    });
  });

  it("keeps a budget-truncated queue and child nonterminal until a suffix attempt exhausts it", async () => {
    const partialCheckpoint = {
      ...recoveryCheckpoint({}, 2),
      nextItemKey: "deferred-coin",
      itemsDone: 10,
      itemsTotal: 20,
    };
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(partialCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({
      status: "degraded",
      metadata: JSON.stringify({
        runBudgetTruncated: true,
        deferredCoins: 10,
        nextCursorStablecoinId: "deferred-coin",
      }),
    });

    const firstSummary = await runFourHourlyReserveSyncSlot(
      buildRuntime(recoveryCheckpoint({}, 2)),
    );

    expect(firstSummary.jobsDegraded).toBe(1);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(setScheduledCheckpointChildDisposition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "sync-live-reserves",
      "not_started",
    );
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();

    const exhaustedCheckpoint = {
      ...recoveryCheckpoint({
        "sync-live-reserves": "not_started",
        "sync-redemption-backstops": "not_started",
        "sync-kinesis-supply": "not_started",
        "reserve-post-sync-watchdog": "not_started",
      }, 3),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({ status: "ok" });
    vi.mocked(finishScheduledCheckpoint).mockClear();
    runLeasedCron.mockClear();

    const retrySummary = await runFourHourlyReserveSyncSlot(
      buildRuntime(exhaustedCheckpoint),
    );

    expect(retrySummary.jobsErrored).toBe(0);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-redemption-backstops",
      "sync-kinesis-supply",
      "reserve-post-sync-watchdog",
    ]);
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("reopens a legacy completed queue child when its durable frontier is unfinished", async () => {
    const legacyCheckpoint = {
      ...recoveryCheckpoint({
        "sync-live-reserves": "completed",
        "sync-redemption-backstops": "completed",
        "sync-kinesis-supply": "completed",
        "reserve-post-sync-watchdog": "completed",
      }, 2),
      nextItemKey: "deferred-coin",
      itemsDone: 10,
      itemsTotal: 20,
    };
    const exhaustedCheckpoint = {
      ...legacyCheckpoint,
      nextItemKey: null,
      itemsDone: 20,
    };
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({ status: "ok" });

    await runFourHourlyReserveSyncSlot(buildRuntime(legacyCheckpoint));

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-redemption-backstops",
      "sync-kinesis-supply",
      "reserve-post-sync-watchdog",
    ]);
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 2 }),
      { state: "completed", error: null },
    );
  });

  it("reopens legacy completed sidecars downstream of a failed child", async () => {
    const legacyCheckpoint = {
      ...recoveryCheckpoint({
        "sync-live-reserves": "completed",
        "sync-redemption-backstops": "failed",
        "sync-kinesis-supply": "completed",
        "reserve-post-sync-watchdog": "completed",
      }, 2),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadScheduledCheckpoint).mockResolvedValue(legacyCheckpoint);

    await runFourHourlyReserveSyncSlot(buildRuntime(legacyCheckpoint));

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-redemption-backstops",
      "sync-kinesis-supply",
      "reserve-post-sync-watchdog",
    ]);
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(finishScheduledCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 2 }),
      { state: "completed", error: null },
    );
  });

  it("leaves sidecars retryable when orchestration fails after queue exhaustion", async () => {
    const exhaustedCheckpoint = {
      ...recoveryCheckpoint({}, 2),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    const orchestrationError = new Error("checkpoint reload unavailable");
    vi.mocked(loadScheduledCheckpoint)
      .mockResolvedValueOnce(exhaustedCheckpoint)
      .mockRejectedValueOnce(orchestrationError);

    await expect(runFourHourlyReserveSyncSlot(buildRuntime(exhaustedCheckpoint)))
      .rejects.toBe(orchestrationError);

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
  });

  function armFaultAt(killPoint: ReserveRecoveryFaultKillPoint) {
    const spec = {
      workerVersion: "preview-v1",
      scheduleKey: "fourHourlyReserveSync" as const,
      slotStartedAt: 0,
      attemptNo: 1,
      killPoint,
      targetItemKey: null,
      armedAt: 0,
      expiresAt: 1_000,
    };
    vi.mocked(loadReserveRecoveryFaultInjectionController).mockResolvedValue({
      spec,
      trigger: vi.fn(async (point) => {
        if (point === killPoint) throw new ReserveRecoveryFaultInjectionTermination(spec);
      }),
    });
  }

  it("leaves the checkpoint nonterminal when preview injection fires after checkpoint creation", async () => {
    armFaultAt("after_checkpoint");

    await expect(runFourHourlyReserveSyncSlot(buildRuntime()))
      .rejects.toBeInstanceOf(ReserveRecoveryFaultInjectionTermination);
    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    ["before_sync-redemption-backstops", syncRedemptionBackstops],
    ["before_sync-kinesis-supply", syncKinesisSupply],
    ["before_reserve-post-sync-watchdog", checkCollateralDrift],
  ] as const)("bypasses checkpoint finalization at %s", async (killPoint, blockedSidecar) => {
    armFaultAt(killPoint);

    await expect(runFourHourlyReserveSyncSlot(buildRuntime()))
      .rejects.toBeInstanceOf(ReserveRecoveryFaultInjectionTermination);
    expect(blockedSidecar).not.toHaveBeenCalled();
    expect(finishScheduledCheckpoint).not.toHaveBeenCalled();
  });
});
