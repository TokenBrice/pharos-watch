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

interface SnapshotPresence {
  psi: boolean;
  publicDataset: boolean;
}

function runtime(
  order: string[],
  presence: SnapshotPresence = { psi: true, publicDataset: true },
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
    slotStartedAt: 3600, // Top of hour no longer runs fallback collection
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

    const summary = await runQuarterHourlySlot(runtime(order));

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins"]);
    expect(mocks.snapshotSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotChainSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    expect(summary.jobsSkipped).toBe(4);
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

  it("fills missing same-day snapshots once and then no-ops", async () => {
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

    await runQuarterHourlySlot(runtime([], presence));
    await runQuarterHourlySlot(runtime([], presence));

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
      { completionReason: "same_day_catch_up" },
    );
  });
});
