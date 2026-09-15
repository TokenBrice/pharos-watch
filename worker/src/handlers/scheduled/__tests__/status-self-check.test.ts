import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  runStatusSelfCheck: vi.fn(),
  runDataInvariantCanary: vi.fn(),
  runCronSentinel: vi.fn(),
  runPriceCorroboration: vi.fn(),
  logCronEvent: vi.fn(async () => undefined),
  recordBudgetSurfaceTelemetry: vi.fn(async () => undefined),
}));

vi.mock("../../../cron/status-self-check", () => ({ runStatusSelfCheck: mocks.runStatusSelfCheck }));
vi.mock("../../../cron/data-invariant-canary", () => ({ runDataInvariantCanary: mocks.runDataInvariantCanary }));
vi.mock("../../../cron/cron-sentinel", () => ({ runCronSentinel: mocks.runCronSentinel }));

vi.mock("../../../cron/sync-stablecoins/price-corroboration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../cron/sync-stablecoins/price-corroboration")>(),
  runPriceCorroboration: mocks.runPriceCorroboration,
}));
vi.mock("../../../lib/cron-logger", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/cron-logger")>(), logCronEvent: mocks.logCronEvent,
}));

vi.mock("../../../lib/budget-surface-telemetry", () => ({ recordBudgetSurfaceTelemetry: mocks.recordBudgetSurfaceTelemetry }));

import { runStatusSelfCheckSlot } from "../status-self-check";

describe("runStatusSelfCheckSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runStatusSelfCheck.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runDataInvariantCanary.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runCronSentinel.mockResolvedValue({ status: "ok", itemCount: 1 });
  });
  it("runs status self-check, canary, and sentinel in plan order", async () => {
    const order: string[] = [];
    const signal = new AbortController().signal;
    mocks.runStatusSelfCheck.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runDataInvariantCanary.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runCronSentinel.mockResolvedValue({ status: "ok", itemCount: 1 });

    const runtime = makeScheduledRuntime({
      scheduleKey: "statusSelfCheckOffset",
      cron: "9 * * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        order.push(job);
        return fn(signal, vi.fn());
      }),
    });

    await runStatusSelfCheckSlot(runtime);

    expect(order).toEqual(SCHEDULED_SLOT_PLANS.statusSelfCheckOffset.jobChains.flat());
    expect(order[0]).toBe("status-self-check");
    expect(order[1]).toBe("data-invariant-canary");
  });
});


describe("hourly corroboration before the next publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runStatusSelfCheck.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runDataInvariantCanary.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runCronSentinel.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  function runtime(order: string[], minute = 9) {
    return makeScheduledRuntime({
      scheduleKey: "statusSelfCheckOffset", cron: `${minute} * * * *`,
      slotStartedAt: 3600 + minute * 60, workerVersion: "deployed-v1",
      runLeasedCron: vi.fn(async (job, fn) => {
        order.push(job);
        return fn(new AbortController().signal, vi.fn());
      }),
    });
  }

  it.each([false, true])("runs after monitors and persists slot/version (provider failed: %s)", async (failed) => {
    const order: string[] = [];
    mocks.runPriceCorroboration.mockImplementation(async () => {
      order.push("price-corroboration");
      return { cohortSize: 2, cacheEntriesWritten: 1,
        addressProviderCount: 0, providerDiagnosticCount: 0,
        fallbackStats: { totalMissing: 2, finalMissing: 1, pass1: 1, pass1b: 0, passCmc: 0,
          passJupiter: 0, passDex: 0, passCgLowVolume: 0, failedPasses: [], providerDiagnostics: [{
            source: "dexscreener-exact", stage: "fallback", endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
            status: failed ? 429 : 200, ok: !failed, success: !failed, errorClass: failed ? "rate-limited" : undefined,
          }] } };
    });
    const ctx = runtime(order);
    await runStatusSelfCheckSlot(ctx);
    expect(order).toEqual(["status-self-check", "data-invariant-canary", "cron-sentinel", "price-corroboration"]);
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      surface: "price-corroboration", outcome: failed ? "degraded" : "ok", dueCount: 2, processedCount: 1,
    }));
    expect(mocks.runPriceCorroboration).toHaveBeenCalledWith(expect.objectContaining({
      signal: ctx.slotSignal, syncStartSec: 4140, chainRpcs: ctx.chainRpcs,
    }));
    expect(mocks.logCronEvent).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      job: "sync-stablecoins", eventType: "price-corroboration", severity: failed ? "warning" : "info",
      metadata: expect.objectContaining({ slotStartedAt: 4140, workerVersion: "deployed-v1", cohortSize: 2 }),
    }));
  });

  it("retains only exception class without changing the monitor result", async () => {
    mocks.runPriceCorroboration.mockRejectedValueOnce(new Error("https://provider/?apikey=secret-token"));
    const summary = await runStatusSelfCheckSlot(runtime([]));
    expect(mocks.logCronEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      severity: "warning", metadata: expect.objectContaining({ errorClass: "Error" }),
    }));
    expect(JSON.stringify(mocks.logCronEvent.mock.calls)).not.toContain("secret-token");
    expect(summary.jobsErrored).toBe(0);
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "price-corroboration", outcome: "error", error: "Error",
    }));
    expect(JSON.stringify(mocks.recordBudgetSurfaceTelemetry.mock.calls)).not.toContain("secret-token");
  });

  it.each([24, 39, 54])("does not collect on minute %s", async (minute) => {
    await runStatusSelfCheckSlot(runtime([], minute));
    expect(mocks.runPriceCorroboration).not.toHaveBeenCalled();
    expect(mocks.logCronEvent).not.toHaveBeenCalled();
    expect(mocks.recordBudgetSurfaceTelemetry).not.toHaveBeenCalled();
  });
});
