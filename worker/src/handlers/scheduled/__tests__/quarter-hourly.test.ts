import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  syncFxRates: vi.fn(),
  syncStablecoins: vi.fn(),
  snapshotSupply: vi.fn(),
  snapshotChainSupply: vi.fn(),
  isPriceCorroborationSlot: vi.fn(() => false),
  runPriceCorroboration: vi.fn(),
  logCronEvent: vi.fn(async () => undefined),
}));

vi.mock("../../../cron/sync-fx-rates", () => ({ syncFxRates: mocks.syncFxRates }));
vi.mock("../../../cron/sync-stablecoins", () => ({ syncStablecoins: mocks.syncStablecoins }));
vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-chain-supply", () => ({ snapshotChainSupply: mocks.snapshotChainSupply }));
vi.mock("../../../cron/sync-stablecoins/price-corroboration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../cron/sync-stablecoins/price-corroboration")>(),
  isPriceCorroborationSlot: mocks.isPriceCorroborationSlot,
  runPriceCorroboration: mocks.runPriceCorroboration,
}));
vi.mock("../../../lib/cron-logger", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/cron-logger")>(), logCronEvent: mocks.logCronEvent,
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
    mocks.isPriceCorroborationSlot.mockReturnValue(false);
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


describe("hourly corroboration event persistence", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isPriceCorroborationSlot.mockReturnValue(false);
  });

  it.each([false, true])("records slot/version and continues snapshots (provider failed: %s)", async (failed) => {
    mocks.isPriceCorroborationSlot.mockReturnValue(true);
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", metadata: JSON.stringify({ downstreamSafe: true }) });
    mocks.runPriceCorroboration.mockResolvedValue({ cohortSize: 2, cacheEntriesWritten: 1,
      addressProviderCount: 0, providerDiagnosticCount: 0,
      fallbackStats: { totalMissing: 2, finalMissing: 1, pass1: 1, pass1b: 0, passCmc: 0,
        passJupiter: 0, passDex: 0, passCgLowVolume: 0, failedPasses: [], providerDiagnostics: [{
          source: "dexscreener-exact", stage: "fallback", endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
          status: failed ? 429 : 200, ok: !failed, success: !failed, errorClass: failed ? "rate-limited" : undefined,
        }] } });
    const order: string[] = [];
    const ctx = { ...runtime(order), slotStartedAt: 3600, workerVersion: "deployed-v1" };
    await runQuarterHourlySlot(ctx);
    expect(mocks.logCronEvent).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      job: "sync-stablecoins", eventType: "price-corroboration", severity: failed ? "warning" : "info",
      metadata: expect.objectContaining({ slotStartedAt: 3600, workerVersion: "deployed-v1", cohortSize: 2 }),
    }));
    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.quarterHourly));
  });

  it("retains only exception class and continues after failed corroboration", async () => {
    mocks.isPriceCorroborationSlot.mockReturnValue(true);
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", metadata: JSON.stringify({ downstreamSafe: true }) });
    mocks.runPriceCorroboration.mockRejectedValueOnce(new Error("https://provider/?apikey=secret-token"));
    const order: string[] = [];
    await runQuarterHourlySlot(runtime(order));
    expect(mocks.logCronEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      severity: "warning", metadata: expect.objectContaining({ errorClass: "Error" }),
    }));
    expect(JSON.stringify(mocks.logCronEvent.mock.calls)).not.toContain("secret-token");
    expect(order).toContain("snapshot-supply");
  });

  it("does not emit an hourly event outside the hourly slot", async () => {
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", metadata: JSON.stringify({ downstreamSafe: true }) });
    await runQuarterHourlySlot(runtime([]));
    expect(mocks.logCronEvent).not.toHaveBeenCalled();
  });
});
