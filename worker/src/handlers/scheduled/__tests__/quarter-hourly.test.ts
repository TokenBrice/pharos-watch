import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  syncFxRates: vi.fn(),
  syncStablecoins: vi.fn(),
  snapshotSupply: vi.fn(),
  snapshotChainSupply: vi.fn(),
}));

vi.mock("../../../cron/sync-fx-rates", () => ({ syncFxRates: mocks.syncFxRates }));
vi.mock("../../../cron/sync-stablecoins", () => ({ syncStablecoins: mocks.syncStablecoins }));
vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-chain-supply", () => ({ snapshotChainSupply: mocks.snapshotChainSupply }));
vi.mock("../../../cron/sync-stablecoins/price-corroboration", () => ({
  isPriceCorroborationSlot: () => false,
  runPriceCorroboration: vi.fn(),
}));
vi.mock("../preflight-skip", () => ({ logSkippedCronRun: vi.fn(async () => undefined) }));

import { runQuarterHourlySlot } from "../quarter-hourly";

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    scheduleKey: "quarterHourly",
    cron: "0 * * * *",
    slotStartedAt: 900, // 00:15 — not a price-corroboration slot
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
  });

  afterEach(() => vi.restoreAllMocks());

  it("runs fx rates before stablecoins, then both snapshots in plan order", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ downstreamSafe: true }),
    });
    const order: string[] = [];

    await runQuarterHourlySlot(runtime(order));

    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.quarterHourly));
    expect(order[0]).toBe("sync-fx-rates");
    expect(order[1]).toBe("sync-stablecoins");
    expect(mocks.snapshotSupply).toHaveBeenCalledOnce();
    expect(mocks.snapshotChainSupply).toHaveBeenCalledOnce();
  });

  it("skips both snapshot jobs when sync-stablecoins reports an unsafe cache", async () => {
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
    expect(summary.jobsSkipped).toBe(2);
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
});
