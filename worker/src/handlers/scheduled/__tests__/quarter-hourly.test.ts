import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncFxRates: vi.fn(),
  syncStablecoins: vi.fn(),
  snapshotSupply: vi.fn(),
  snapshotChainSupply: vi.fn(),
  snapshotPsiDaily: vi.fn(),
  snapshotPublicDataset: vi.fn(),
}));

vi.mock("../../../cron/sync-fx-rates", () => ({ syncFxRates: mocks.syncFxRates }));
vi.mock("../../../cron/sync-stablecoins", () => ({ syncStablecoins: mocks.syncStablecoins }));
vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-chain-supply", () => ({ snapshotChainSupply: mocks.snapshotChainSupply }));
vi.mock("../../../cron/snapshot-psi", () => ({ snapshotPsiDaily: mocks.snapshotPsiDaily }));
vi.mock("../../../cron/snapshot-public-dataset", () => ({ snapshotPublicDataset: mocks.snapshotPublicDataset }));
vi.mock("../preflight-skip", () => ({ logSkippedCronRun: vi.fn(async () => undefined) }));

import { runQuarterHourlySlot } from "../quarter-hourly";
import { logSkippedCronRun } from "../preflight-skip";

interface SnapshotPresence {
  psi: boolean;
  publicDataset: boolean;
}

const DAY_START = 1_790_035_200; // 2026-09-22T00:00:00Z
const SLOT_0700 = DAY_START + 7 * 3600;
const SLOT_0800 = DAY_START + 8 * 3600;
const SLOT_0900 = DAY_START + 9 * 3600;

function runtime(
  order: string[],
  presence: SnapshotPresence = { psi: true, publicDataset: true },
  slotStartedAt = SLOT_0900,
): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => ({
          present: sql.includes("stability_index")
            ? Number(presence.psi)
            : Number(presence.publicDataset),
        }),
      }),
    }),
  } as unknown as D1Database;
  return makeScheduledRuntime({
    db,
    scheduleKey: "quarterHourly",
    cron: "0 * * * *",
    slotStartedAt,
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("runQuarterHourlySlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncFxRates.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotChainSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPsiDaily.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPublicDataset.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("skips all snapshot jobs when sync-stablecoins reports an unsafe cache", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ downstreamSafe: false }),
    });
    const order: string[] = [];

    const summary = await runQuarterHourlySlot(runtime(order, { psi: false, publicDataset: false }));

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins"]);
    expect(mocks.snapshotSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotChainSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    expect(summary.jobsSkipped).toBe(4);
  });

  it("records an already-completed daily snapshot as not due instead of cache-gated", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ downstreamSafe: false }),
    });
    const order: string[] = [];

    await runQuarterHourlySlot(runtime(order, { psi: true, publicDataset: true }));

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins", "snapshot-psi", "snapshot-public-dataset"]);
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    const skippedJobs = vi.mocked(logSkippedCronRun).mock.calls.map(([, entry]) => entry.job);
    expect(skippedJobs).toEqual(["snapshot-supply", "snapshot-chain-supply"]);
  });

  it("records a failed due-check read as the job's error instead of treating the day as missing", async () => {
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", itemCount: 1, metadata: JSON.stringify({ downstreamSafe: true, capabilities: { stablecoinsCache: true } }) });
    const order: string[] = [];
    const failingDb = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 unavailable"); } }) }),
    } as unknown as D1Database;

    const summary = await runQuarterHourlySlot({ ...runtime(order), db: failingDb });

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins", "snapshot-supply", "snapshot-chain-supply", "snapshot-psi", "snapshot-public-dataset"]);
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    expect(summary.jobsErrored).toBe(2);
  });

  it("retries a transient D1 overload in the same-day precheck instead of recording an error run", async () => {
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", itemCount: 1, metadata: JSON.stringify({ downstreamSafe: true }) });
    const order: string[] = [];
    let psiReads = 0;
    let publicReads = 0;
    // First precheck read per job hits the transient D1 internal error seen
    // in production (cron run 2026-09-23 09:31); the retry succeeds.
    const flakyDb = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            const isPsi = sql.includes("stability_index");
            if (isPsi ? psiReads++ === 0 : publicReads++ === 0) {
              throw new Error("D1_ERROR: internal error; reference = fbgkvk0rf5kea3obe144noi3");
            }
            return { present: 1 };
          },
        }),
      }),
    } as unknown as D1Database;
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const summary = await runQuarterHourlySlot({ ...runtime(order), db: flakyDb });

      expect(order).toEqual([
        "sync-fx-rates",
        "sync-stablecoins",
        "snapshot-supply",
        "snapshot-chain-supply",
        "snapshot-psi",
        "snapshot-public-dataset",
      ]);
      expect(summary.jobsErrored).toBe(0);
      expect(summary.jobsSkipped).toBe(0);
      expect(summary.jobsNeutralSkipped).toBe(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("runs snapshot jobs when sync-stablecoins writes a safe cache with depeg failures", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        downstreamSafe: true,
        depegErrorCount: 1,
        capabilities: { stablecoinsCache: true, depegPipeline: false },
      }),
    });

    await runQuarterHourlySlot(runtime([]));

    expect(mocks.snapshotSupply).toHaveBeenCalledOnce();
    expect(mocks.snapshotChainSupply).toHaveBeenCalledOnce();
  });

  it("fills missing same-day snapshots once the 08:00 slot has passed, then no-ops", async () => {
    const presence = { psi: false, publicDataset: false };
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ downstreamSafe: true }),
    });
    mocks.snapshotPsiDaily.mockImplementation(async () => {
      presence.psi = true;
      return { status: "ok", itemCount: 1 };
    });
    mocks.snapshotPublicDataset.mockImplementation(async () => {
      presence.publicDataset = true;
      return { status: "ok", itemCount: 1 };
    });

    await runQuarterHourlySlot(runtime([], presence, SLOT_0900));
    await runQuarterHourlySlot(runtime([], presence, SLOT_0900));

    expect(mocks.snapshotPsiDaily).toHaveBeenCalledOnce();
    expect(mocks.snapshotPsiDaily).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(AbortSignal),
      { completionReason: "same_day_catch_up" },
    );
    expect(mocks.snapshotPublicDataset).toHaveBeenCalledOnce();
    expect(mocks.snapshotPublicDataset).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(AbortSignal),
      {
        completionReason: "same_day_catch_up",
        minStablecoinsCacheUpdatedAtSec: SLOT_0800,
        freshnessGateLabel: "daily0800Utc",
      },
    );
  });

  it("leaves a missing daily snapshot to the 08:00 slot while the day is still before it", async () => {
    const presence = { psi: false, publicDataset: false };
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ downstreamSafe: true }),
    });

    await runQuarterHourlySlot(runtime([], presence, SLOT_0700));

    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
  });
});
