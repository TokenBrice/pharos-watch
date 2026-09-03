import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { runFourHourlyReserveSyncSlot } from "../hourly-live-reserves";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

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
vi.mock("../../../lib/live-reserves/store", () => ({
  getMaxSyncAge: vi.fn(),
  computeReserveCompositionOverview: vi.fn(),
}));
vi.mock("../../../lib/db-cache", () => ({
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => {}),
}));
vi.mock("../../../lib/scheduled-recovery-checkpoint", async () => {
  // vi.mock factories are hoisted above static imports; the fixture must load inside the factory.
  const { makeLiveReserveCheckpoint } = await import("../../../lib/__tests__/scheduled-recovery-checkpoint.test-support");
  return {
    beginLiveReserveCheckpoint: vi.fn(async () => makeLiveReserveCheckpoint()),
    loadLiveReserveCheckpoint: vi.fn(),
    setLiveReserveCheckpointChildDisposition: vi.fn(async () => {}),
    finishLiveReserveCheckpoint: vi.fn(async () => {}),
  };
});
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));

import { syncLiveReserves } from "../../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../../lib/collateral-drift";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../../lib/live-reserves/store";
import { emptyReserveCompositionOverview } from "../../../lib/live-reserves/store-shared";
import { makeLiveReserveCheckpoint } from "../../../lib/__tests__/scheduled-recovery-checkpoint.test-support";
import { getCache, setCache } from "../../../lib/db-cache";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../../lib/alert-reserve-source-cache";
import { SNAPSHOT_KEYS } from "../../../cron/telegram-alert-snapshots";
import {
  finishLiveReserveCheckpoint,
  loadLiveReserveCheckpoint,
  setLiveReserveCheckpointChildDisposition,
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
      ...emptyReserveCompositionOverview(),
      historyWriteGapCheckFailed: false,
    });
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(recoveryCheckpoint());
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runLeasedCron = vi.fn(
      async (_job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
        return fn(new AbortController().signal, async () => {});
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    errorSpy.mockRestore();
  });

  function buildRuntime(
    recoveryCheckpoint?: ScheduledRecoveryCheckpoint,
  ): ScheduledRuntimeContext {
    return makeScheduledRuntime({
      db: {} as D1Database,
      cron: "11 */4 * * *",
      scheduleKey: "fourHourlyReserveSync",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
      ...(recoveryCheckpoint ? { recoveryCheckpoint } : {}),
    });
  }

  function recoveryCheckpoint(
    childDispositions: ScheduledRecoveryCheckpoint["childDispositions"] = {},
    attemptNo = 2,
  ): ScheduledRecoveryCheckpoint {
    return makeLiveReserveCheckpoint({
      attemptNo,
      executionGeneration: attemptNo,
      invocationId: `recovery-owner-${attemptNo}`,
      workerVersion: "preview-v1",
      state: "recovering",
      childDispositions,
      recoveryOwner: `recovery-owner-${attemptNo}`,
      recoveryLeaseUntil: 1_000,
      sourceAttemptNo: attemptNo - 1,
    });
  }

  it("keeps reserve-dependent sidecars pending and still runs independent Kinesis after a reserve failure", async () => {
    vi.mocked(syncLiveReserves).mockRejectedValue(new Error("sync blew up"));
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue({
      ...recoveryCheckpoint(),
      nextItemKey: "unfinished-coin",
      itemsDone: 0,
      itemsTotal: 20,
    });

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 1,
      jobsErrored: 1,
      jobsSkipped: 2,
    });

    expect(syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-kinesis-supply",
    ]);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
    const errorLine = errorSpy.mock.calls
      .map((call: readonly unknown[]) => call[0])
      .find((value: unknown): value is string => typeof value === "string" && value.includes("Live reserves sync failed"));
    expect(errorLine).toBeDefined();
    if (typeof errorLine !== "string") throw new Error("expected a structured reserve failure log line");
    const errorRecord = JSON.parse(errorLine) as {
      message?: string;
      errorName?: string;
      errorMessage?: string;
      errorStack?: string;
    };
    expect(errorRecord).toMatchObject({
      message: "[hourly-live-reserves] Live reserves sync failed:",
      errorName: "Error",
      errorMessage: "sync blew up",
    });
    expect(errorRecord.errorStack).toContain("sync blew up");
  });

  it("terminalizes an exhausted all-error queue while still running independent Kinesis", async () => {
    const exhaustedCheckpoint = {
      ...recoveryCheckpoint({}, 2),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({
      status: "error",
      error: "all reserve adapters failed",
    });

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(exhaustedCheckpoint));

    expect(summary).toMatchObject({ jobsErrored: 1, jobsSkipped: 2 });
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-kinesis-supply",
    ]);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 2 }),
      {
        state: "failed",
        error: "live reserve queue exhausted without a successful result",
      },
    );
  });

  it("does not let a redemption failure block Kinesis or the reserve watchdog", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValue(new Error("rb blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsRun: 3,
      jobsErrored: 1,
      jobsSkipped: 0,
    });

    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
    const errorLine = errorSpy.mock.calls
      .map((call: readonly unknown[]) => call[0])
      .find((value: unknown): value is string => typeof value === "string" && value.includes("Redemption backstops sync failed"));
    expect(errorLine).toBeDefined();
    if (typeof errorLine !== "string") throw new Error("expected a structured redemption failure log line");
    const errorRecord = JSON.parse(errorLine) as {
      message?: string;
      errorName?: string;
      errorMessage?: string;
      errorStack?: string;
    };
    expect(errorRecord).toMatchObject({
      message: "[hourly-live-reserves] Redemption backstops sync failed:",
      errorName: "Error",
      errorMessage: "rb blew up",
    });
    expect(errorRecord.errorStack).toContain("rb blew up");
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

  it.each([
    "sync-live-reserves",
    "sync-redemption-backstops",
    "sync-kinesis-supply",
    "cron-sentinel",
  ] as const)("keeps a checkpoint recoverable when %s is lease-contended", async (contendedJob) => {
    runLeasedCron.mockImplementation(
      async (job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
        if (job === contendedJob) return { status: "skipped_locked" };
        return fn(new AbortController().signal, async () => {});
      },
    );

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(summary.jobsSkipped).toBeGreaterThan(0);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
    expect(vi.mocked(setLiveReserveCheckpointChildDisposition).mock.calls).not.toContainEqual([
      expect.anything(),
      expect.anything(),
      contendedJob,
      "completed",
    ]);
    const expectedJobsThroughContention = {
      "sync-live-reserves": ["sync-live-reserves", "sync-kinesis-supply"],
      "sync-redemption-backstops": [
        "sync-live-reserves",
        "sync-redemption-backstops",
        "sync-kinesis-supply",
        "cron-sentinel",
      ],
      "sync-kinesis-supply": [
        "sync-live-reserves",
        "sync-redemption-backstops",
        "sync-kinesis-supply",
        "cron-sentinel",
      ],
      "cron-sentinel": [
        "sync-live-reserves",
        "sync-redemption-backstops",
        "sync-kinesis-supply",
        "cron-sentinel",
      ],
    } as const;
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(expectedJobsThroughContention[contendedJob]);
  });

  it("retries an unfinished sidecar without replaying completed checkpoint children", async () => {
    let redemptionContended = true;
    runLeasedCron.mockImplementation(
      async (job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
        if (job === "sync-redemption-backstops" && redemptionContended) {
          return { status: "skipped_locked" };
        }
        return fn(new AbortController().signal, async () => {});
      },
    );

    const firstSummary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(firstSummary.jobsSkipped).toBe(1);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();

    redemptionContended = false;
    runLeasedCron.mockClear();
    vi.mocked(finishLiveReserveCheckpoint).mockClear();
    const successor = recoveryCheckpoint(
      {
        "sync-live-reserves": "completed",
        "sync-redemption-backstops": "not_started",
        "sync-kinesis-supply": "completed",
        "cron-sentinel": "completed",
      },
      3,
    );
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(successor);

    const retrySummary = await runFourHourlyReserveSyncSlot(buildRuntime(successor));

    expect(retrySummary.jobsSkipped).toBe(0);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-redemption-backstops"]);
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("retries a failed redemption sidecar without replaying independent completed children", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValueOnce(new Error("redemption failed"));

    const firstSummary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(firstSummary).toMatchObject({ jobsErrored: 1, jobsSkipped: 0 });
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();

    const successor = recoveryCheckpoint(
      {
        "sync-live-reserves": "completed",
        "sync-redemption-backstops": "not_started",
        "sync-kinesis-supply": "completed",
        "cron-sentinel": "completed",
      },
      3,
    );
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(successor);
    runLeasedCron.mockClear();

    const retrySummary = await runFourHourlyReserveSyncSlot(buildRuntime(successor));

    expect(retrySummary).toMatchObject({ jobsErrored: 0, jobsSkipped: 0 });
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-redemption-backstops"]);
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("resets a child to not_started when its body reports a lease skip", async () => {
    vi.mocked(syncKinesisSupply).mockResolvedValue({ status: "skipped_locked" } as never);

    const summary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));

    expect(summary.jobsSkipped).toBe(1);
    expect(setLiveReserveCheckpointChildDisposition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "sync-kinesis-supply",
      "not_started",
    );
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
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
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(partialCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({
      status: "degraded",
      metadata: JSON.stringify({
        runBudgetTruncated: true,
        deferredCoins: 10,
        nextCursorStablecoinId: "deferred-coin",
      }),
    });

    const firstSummary = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint({}, 2)));

    expect(firstSummary.jobsDegraded).toBe(1);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-kinesis-supply",
    ]);
    expect(setLiveReserveCheckpointChildDisposition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "sync-live-reserves",
      "not_started",
    );
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();

    const exhaustedCheckpoint = {
      ...recoveryCheckpoint(
        {
          "sync-live-reserves": "not_started",
          "sync-redemption-backstops": "not_started",
          "sync-kinesis-supply": "completed",
          "cron-sentinel": "not_started",
        },
        3,
      ),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({ status: "ok" });
    vi.mocked(finishLiveReserveCheckpoint).mockClear();
    runLeasedCron.mockClear();

    const retrySummary = await runFourHourlyReserveSyncSlot(buildRuntime(exhaustedCheckpoint));

    expect(retrySummary.jobsErrored).toBe(0);
    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual([
      "sync-live-reserves",
      "sync-redemption-backstops",
      "cron-sentinel",
    ]);
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 3 }),
      { state: "completed", error: null },
    );
  });

  it("reopens a legacy completed queue child when its durable frontier is unfinished", async () => {
    const legacyCheckpoint = {
      ...recoveryCheckpoint(
        {
          "sync-live-reserves": "completed",
          "sync-redemption-backstops": "completed",
          "sync-kinesis-supply": "completed",
          "cron-sentinel": "completed",
        },
        2,
      ),
      nextItemKey: "deferred-coin",
      itemsDone: 10,
      itemsTotal: 20,
    };
    const exhaustedCheckpoint = {
      ...legacyCheckpoint,
      nextItemKey: null,
      itemsDone: 20,
    };
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(exhaustedCheckpoint);
    vi.mocked(syncLiveReserves).mockResolvedValue({ status: "ok" });

    await runFourHourlyReserveSyncSlot(buildRuntime(legacyCheckpoint));

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNo: 2 }),
      { state: "completed", error: null },
    );
  });

  it("reopens only the failed legacy sidecar and preserves independent completed children", async () => {
    const legacyCheckpoint = {
      ...recoveryCheckpoint(
        {
          "sync-live-reserves": "completed",
          "sync-redemption-backstops": "failed",
          "sync-kinesis-supply": "completed",
          "cron-sentinel": "completed",
        },
        2,
      ),
      nextItemKey: null,
      itemsDone: 20,
      itemsTotal: 20,
    };
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue(legacyCheckpoint);

    await runFourHourlyReserveSyncSlot(buildRuntime(legacyCheckpoint));

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-redemption-backstops"]);
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishLiveReserveCheckpoint).toHaveBeenCalledWith(
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
    vi.mocked(loadLiveReserveCheckpoint)
      .mockResolvedValueOnce(exhaustedCheckpoint)
      .mockRejectedValueOnce(orchestrationError);

    await expect(runFourHourlyReserveSyncSlot(buildRuntime(exhaustedCheckpoint))).rejects.toBe(orchestrationError);

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves"]);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
  });
});
