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
const sentinelSourceStates = vi.hoisted(() => new Map<string, { value: string; updatedAt: number }>());
vi.mock("../../../lib/db-cache", () => ({
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => {}),
  getCaches: vi.fn(async () => new Map(sentinelSourceStates)),
  setCacheIfNewer: vi.fn(async (_db, key, value, updatedAt) => {
    if ((sentinelSourceStates.get(key)?.updatedAt ?? -1) < updatedAt) {
      sentinelSourceStates.set(key, { value, updatedAt });
    }
    return { written: true, skippedBecauseNewer: false };
  }),
}));
vi.mock("../../../lib/scheduled-recovery-checkpoint", async () => {
  // vi.mock factories are hoisted above static imports; the fixture must load inside the factory.
  const { makeLiveReserveCheckpoint } = await import("../../../lib/__tests__/scheduled-recovery-checkpoint.test-support");
  return {
    beginLiveReserveCheckpoint: vi.fn(async () => makeLiveReserveCheckpoint()),
    loadLiveReserveCheckpoint: vi.fn(),
    releaseUnstartedLiveReserveRecoveryClaim: vi.fn(async () => ({ disposition: "released" })),
    setLiveReserveCheckpointChildDisposition: vi.fn(async () => {}),
    finishLiveReserveCheckpoint: vi.fn(async () => {}),
  };
});
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/reserve-producer-priority", () => ({
  getReserveProducerPriority: vi.fn(),
}));

import { syncLiveReserves } from "../../../cron/sync-live-reserves";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import { syncRedemptionBackstops } from "../../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../../lib/collateral-drift";
import { logSkippedCronRun } from "../preflight-skip";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../../lib/live-reserves/store";
import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";
import { makeLiveReserveCheckpoint } from "../../../lib/__tests__/scheduled-recovery-checkpoint.test-support";
import { getCache, setCache } from "../../../lib/db-cache";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../../lib/alert-reserve-source-cache";
import { SNAPSHOT_KEYS } from "../../../cron/telegram-alert-snapshots";
import { getReserveProducerPriority } from "../../../lib/reserve-producer-priority";
import {
  finishLiveReserveCheckpoint,
  loadLiveReserveCheckpoint,
  releaseUnstartedLiveReserveRecoveryClaim,
  setLiveReserveCheckpointChildDisposition,
  type ScheduledRecoveryCheckpoint,
} from "../../../lib/scheduled-recovery-checkpoint";

describe("runFourHourlyReserveSyncSlot", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sentinelSourceStates.clear();
    vi.mocked(getReserveProducerPriority).mockResolvedValue(null);
    vi.mocked(releaseUnstartedLiveReserveRecoveryClaim).mockReset().mockResolvedValue({ disposition: "released" });
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
      db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database,
      cron: "11 */4 * * *",
      scheduleKey: "fourHourlyReserveSync",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
      ...(recoveryCheckpoint ? { recoveryCheckpoint, invocationId: recoveryCheckpoint.invocationId } : {}),
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

  it.each([true, false])("forwards native adapter capability only when admitted: %s", async admitted => {
    const runtime = buildRuntime();
    const capability = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    runtime.dwellirNative = capability;
    await runFourHourlyReserveSyncSlot(runtime);
    expect(vi.mocked(syncLiveReserves).mock.calls[0]?.[2]?.dwellirNative).toBe(capability);
  });

  it("defers a direct checkpoint replay without running producer or consumers beside a heavy slot", async () => {
    vi.mocked(getReserveProducerPriority).mockResolvedValue({
      reason: "heavy-slot-co-tenancy", scheduleKey: "v9PublicationOffset",
      slotStartedAt: 900, observedAt: 1000, lookaheadSec: 1440, condition: "heavy-slot-running",
    });
    const result = await runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));
    expect(result).toMatchObject({ jobsErrored: 0, jobsDegraded: 0, jobsNeutralSkipped: 4 });
    expect(syncLiveReserves).not.toHaveBeenCalled();
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).not.toHaveBeenCalled();
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
    expect(logSkippedCronRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "skipped_neutral", reason: "heavy-slot-co-tenancy",
    }));
  });

  it.each(["released", "not-owned", "already-started"] as const)(
    "awaits the second guard's release without starting children or concealing a CAS miss (%s)",
    async (disposition) => {
      vi.mocked(getReserveProducerPriority).mockResolvedValue({
        reason: "heavy-slot-co-tenancy", scheduleKey: "v9PublicationOffset",
        slotStartedAt: 900, observedAt: 1000, lookaheadSec: 1440, condition: "heavy-slot-running",
      });
      let completeRelease!: () => void;
      let releaseStarted!: () => void;
      const gate = new Promise<void>((resolve) => { completeRelease = resolve; });
      const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
      vi.mocked(releaseUnstartedLiveReserveRecoveryClaim).mockImplementationOnce(async () => {
        releaseStarted();
        await gate;
        return { disposition };
      });
      let settled = false;
      const pending = runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint())).then((summary) => {
        settled = true;
        return summary;
      });
      try {
        await started;
        expect(settled).toBe(false);
        expect(logSkippedCronRun).not.toHaveBeenCalled();
      } finally {
        completeRelease();
        await pending;
      }
      expect(logSkippedCronRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        metadata: expect.objectContaining({ recoveryClaimRelease: { disposition } }),
      }));
      expect(syncLiveReserves).not.toHaveBeenCalled();
      expect(syncRedemptionBackstops).not.toHaveBeenCalled();
      expect(syncKinesisSupply).not.toHaveBeenCalled();
      expect(setLiveReserveCheckpointChildDisposition).not.toHaveBeenCalled();
      expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "foreign-invocation"])("does not release another invocation's checkpoint (%s)", async (invocationId) => {
    vi.mocked(getReserveProducerPriority).mockResolvedValue({
      reason: "heavy-slot-co-tenancy", scheduleKey: "v9PublicationOffset",
      slotStartedAt: 900, observedAt: 1000, lookaheadSec: 1440, condition: "heavy-slot-running",
    });
    const runtime = buildRuntime(recoveryCheckpoint());
    runtime.invocationId = invocationId;
    const result = await runFourHourlyReserveSyncSlot(runtime);
    expect(result).toMatchObject({ jobsNeutralSkipped: 4 });
    expect(releaseUnstartedLiveReserveRecoveryClaim).not.toHaveBeenCalled();
    expect(logSkippedCronRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({ recoveryClaimRelease: { disposition: "not-owned" } }),
    }));
    expect(setLiveReserveCheckpointChildDisposition).not.toHaveBeenCalled();
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
  });

  it("keeps recovery's two-connection head separate from independent Kinesis I/O", async () => {
    // The Worker TS target lacks Promise.withResolvers; use the suite's gates.
    let releaseHead!: () => void;
    let headStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const started = new Promise<void>((resolve) => { headStarted = resolve; });
    let active = 0;
    let peak = 0;
    vi.mocked(syncLiveReserves).mockImplementation(async () => {
      active += 2;
      peak = Math.max(peak, active);
      headStarted();
      await gate;
      active -= 2;
      return { status: "ok" };
    });
    vi.mocked(syncKinesisSupply).mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { status: "ok" };
    });
    const pending = runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()));
    try {
      await started;
      expect(syncKinesisSupply).not.toHaveBeenCalled();
    } finally {
      releaseHead();
      await pending;
    }
    expect(peak).toBe(2);
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
  });

  it("runs accepted redemption fallback but blocks the sentinel after a reserve failure", async () => {
    vi.mocked(syncLiveReserves).mockRejectedValue(new Error("sync blew up"));
    vi.mocked(loadLiveReserveCheckpoint).mockResolvedValue({
      ...recoveryCheckpoint(),
      nextItemKey: "unfinished-coin",
      itemsDone: 0,
      itemsTotal: 20,
    });

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toMatchObject({
      jobsErrored: 1,
      jobsSkipped: 1,
    });

    expect(syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(syncRedemptionBackstops).toHaveBeenCalledTimes(1);
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    // The watchdog validates the live-reserve generation this slot was supposed
    // to write, so an unfinished queue must leave the drift envelope untouched
    // instead of re-publishing the previous generation as current.
    expect(checkCollateralDrift).not.toHaveBeenCalled();
    expect(logSkippedCronRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        job: "cron-sentinel",
        reason: "upstream-incomplete:sync-live-reserves",
      }),
    );
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort()).toEqual([
      "sync-kinesis-supply",
      "sync-live-reserves",
      "sync-redemption-backstops",
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

  it("terminalizes an exhausted all-error queue while still running the independent chains", async () => {
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

    expect(summary).toMatchObject({ jobsErrored: 1, jobsSkipped: 1 });
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort()).toEqual([
      "sync-kinesis-supply",
      "sync-live-reserves",
      "sync-redemption-backstops",
    ]);
    expect(syncRedemptionBackstops).toHaveBeenCalledTimes(1);
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

  it("observes the reserve generation only after the producer that writes it settles", async () => {
    let releaseSync: () => void = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const order: string[] = [];
    vi.mocked(syncLiveReserves).mockImplementation((async () => {
      order.push("producer:start");
      await syncGate;
      order.push("producer:end");
    }) as never);
    vi.mocked(checkCollateralDrift).mockImplementation((async () => {
      order.push("watchdog:drift-read");
      return { driftCoins: [], fallbackCoins: [] };
    }) as never);

    releaseSync();
    await expect(runFourHourlyReserveSyncSlot(buildRuntime(recoveryCheckpoint()))).resolves
      .toMatchObject({ jobsErrored: 0, jobsSkipped: 0 });

    // Running the watchdog beside the producer let it read and re-publish the
    // previous generation as freshly validated before this slot's rows landed.
    expect(order).toEqual(["producer:start", "producer:end", "watchdog:drift-read"]);
    expect(
      vi.mocked(setCache).mock.calls.some(([, key]) => key === SNAPSHOT_KEYS.reserve),
    ).toBe(true);
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
      // A lease-contended producer leaves the queue unfinished, so both reserve
      // consumers stay blocked instead of observing a partial generation.
      "sync-live-reserves": ["sync-kinesis-supply", "sync-live-reserves", "sync-redemption-backstops"],
      "sync-redemption-backstops": [
        "cron-sentinel",
        "sync-kinesis-supply",
        "sync-live-reserves",
        "sync-redemption-backstops",
      ],
      "sync-kinesis-supply": [
        "cron-sentinel",
        "sync-kinesis-supply",
        "sync-live-reserves",
        "sync-redemption-backstops",
      ],
      "cron-sentinel": [
        "cron-sentinel",
        "sync-kinesis-supply",
        "sync-live-reserves",
        "sync-redemption-backstops",
      ],
    } as const;
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort())
      .toEqual([...expectedJobsThroughContention[contendedJob]]);
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
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort()).toEqual([
      "sync-kinesis-supply",
      "sync-live-reserves",
      "sync-redemption-backstops",
    ]);
    expect(checkCollateralDrift).not.toHaveBeenCalled();
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
          "sync-redemption-backstops": "completed",
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
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort()).toEqual([
      "cron-sentinel",
      "sync-live-reserves",
      "sync-redemption-backstops",
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

    expect(runLeasedCron.mock.calls.map(([job]) => job)).toEqual(["sync-live-reserves", "sync-redemption-backstops"]);
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

    // Only the two independently launched chains have started at this point;
    // the reserve consumers are never launched beside the producer.
    expect(runLeasedCron.mock.calls.map(([job]) => job).sort()).toEqual([
      "sync-kinesis-supply",
      "sync-live-reserves",
    ]);
    expect(syncRedemptionBackstops).not.toHaveBeenCalled();
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(finishLiveReserveCheckpoint).not.toHaveBeenCalled();
  });
});
