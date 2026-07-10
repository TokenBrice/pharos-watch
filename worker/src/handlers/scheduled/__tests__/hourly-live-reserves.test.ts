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
  setScheduledCheckpointChildDisposition: vi.fn(async () => {}),
  finishScheduledCheckpoint: vi.fn(async () => {}),
  checkpointErrorMetadata: vi.fn(() => "error"),
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
import {
  loadReserveRecoveryFaultInjectionController,
  ReserveRecoveryFaultInjectionTermination,
  type ReserveRecoveryFaultKillPoint,
} from "../../../lib/reserve-recovery-fault-injection";
import { finishScheduledCheckpoint } from "../../../lib/scheduled-recovery-checkpoint";

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
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runLeasedCron = vi.fn(async (_job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
      return fn(new AbortController().signal, async () => {});
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    errorSpy.mockRestore();
  });

  function buildRuntime(): ScheduledRuntimeContext {
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
    };
  }

  it("skips downstream reserve tasks but still runs drift check when sync-live-reserves throws", async () => {
    vi.mocked(syncLiveReserves).mockRejectedValue(new Error("sync blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 1,
      jobsErrored: 1,
      jobsSkipped: 2,
    });

    expect(syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(runLeasedCron).toHaveBeenCalledWith("reserve-post-sync-watchdog", expect.any(Function));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Live reserves sync failed"),
      expect.any(Error),
    );
  });

  it("skips kinesis but still runs drift check when redemption backstops throws", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValue(new Error("rb blew up"));
    vi.mocked(syncKinesisSupply).mockRejectedValue(new Error("ks blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 2,
      jobsErrored: 1,
      jobsSkipped: 1,
    });

    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
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
