import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  runStatusSelfCheck: vi.fn(),
  runDataInvariantCanary: vi.fn(),
  runCronSentinel: vi.fn(),
  runPriceCorroboration: vi.fn(),
  runPriceDexRefresh: vi.fn(),
  logCronEvent: vi.fn(async () => undefined),
  recordBudgetSurfaceTelemetry: vi.fn(async () => undefined),
}));

vi.mock("../../../cron/sync-stablecoins/price-dex-refresh", () => ({ runPriceDexRefresh: mocks.runPriceDexRefresh }));

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

describe("hourly corroboration before the next publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runPriceDexRefresh.mockResolvedValue({ cohortSize: 1, resolved: 1, attemptedBatches: 1, deferredBatches: 0, unsupportedAssets: 0, missingQuotes: 0, timedOut: false, cacheWritten: true, errorClasses: [] });
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
    mocks.runPriceDexRefresh.mockImplementation(async () => {
      order.push("dex-refresh");
      return { cohortSize: 1, resolved: 1, attemptedBatches: 1, deferredBatches: 0, unsupportedAssets: 0, missingQuotes: 0, timedOut: false, cacheWritten: true, errorClasses: [] };
    });
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
    expect(order).toEqual(["status-self-check", "data-invariant-canary", "cron-sentinel", "dex-refresh", "price-corroboration"]);
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

  it("keeps a failed DEX refresh degraded when broad collection succeeds", async () => {
    mocks.runPriceDexRefresh.mockResolvedValueOnce({ cohortSize: 1, resolved: 0, attemptedBatches: 1, deferredBatches: 0,
      unsupportedAssets: 0, missingQuotes: 1, timedOut: false, cacheWritten: true, errorClasses: ["http-error"] });
    mocks.runPriceCorroboration.mockResolvedValueOnce({ cohortSize: 2, cacheEntriesWritten: 2,
      addressProviderCount: 0, providerDiagnosticCount: 0, fallbackStats: { totalMissing: 2, finalMissing: 0,
        pass1: 2, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0,
        failedPasses: [], providerDiagnostics: [] } });
    await runStatusSelfCheckSlot(runtime([]));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "degraded" }));
  });

  it("reports ok when a successful round-trip resolves only unsupported and pool-less cohort rows", async () => {
    mocks.runPriceDexRefresh.mockResolvedValueOnce({ cohortSize: 10, resolved: 0, attemptedBatches: 3, deferredBatches: 0,
      unsupportedAssets: 3, missingQuotes: 6, hintedAttempted: 0, hintedResolved: 0, timedOut: false, cacheWritten: true, errorClasses: [] });
    await runStatusSelfCheckSlot(runtime([], 24));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "ok" }));
  });

  it("degrades when previously resolvable routes answer without any quote", async () => {
    mocks.runPriceDexRefresh.mockResolvedValueOnce({ cohortSize: 10, resolved: 0, attemptedBatches: 3, deferredBatches: 0,
      unsupportedAssets: 3, missingQuotes: 7, hintedAttempted: 1, hintedResolved: 0, timedOut: false, cacheWritten: true, errorClasses: [] });
    await runStatusSelfCheckSlot(runtime([], 24));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "degraded" }));
  });

  it("keeps budget-exhaustion deferrals degraded without error classes", async () => {
    mocks.runPriceDexRefresh.mockResolvedValueOnce({ cohortSize: 320, resolved: 30, attemptedBatches: 9, deferredBatches: 2,
      unsupportedAssets: 0, missingQuotes: 0, timedOut: false, cacheWritten: true, errorClasses: [] });
    await runStatusSelfCheckSlot(runtime([], 24));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "degraded" }));
  });

  it.each([
    [["rate-limited"], "ok"],
    [["circuit-open"], "degraded"],
    [["rate-limited", "http-error"], "degraded"],
  ])("treats a slot refused with %j as %s (throttling escalates through the refresh circuit)", async (errorClasses, outcome) => {
    mocks.runPriceDexRefresh.mockResolvedValueOnce({ cohortSize: 2, resolved: 0, attemptedBatches: 1, deferredBatches: 1,
      unsupportedAssets: 0, missingQuotes: 2, hintedAttempted: 1, hintedResolved: 0, timedOut: false, cacheWritten: true, errorClasses });
    await runStatusSelfCheckSlot(runtime([], 24));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome }));
  });

  it("continues hourly recovery when the DEX routing cache fails", async () => {
    mocks.runPriceDexRefresh.mockRejectedValueOnce(new Error("private cache detail"));
    mocks.runPriceCorroboration.mockResolvedValueOnce({ cohortSize: 2, cacheEntriesWritten: 2,
      addressProviderCount: 0, providerDiagnosticCount: 0, fallbackStats: { totalMissing: 2, finalMissing: 0,
        pass1: 2, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0,
        failedPasses: [], providerDiagnostics: [] } });
    await runStatusSelfCheckSlot(runtime([]));
    expect(mocks.runPriceCorroboration).toHaveBeenCalledOnce();
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "error",
      metadata: expect.objectContaining({ phaseErrors: { "dex-refresh": "Error" } }) }));
    expect(JSON.stringify(mocks.recordBudgetSurfaceTelemetry.mock.calls)).not.toContain("private cache detail");
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
      metadata: expect.objectContaining({ dexRefresh: expect.objectContaining({ resolved: 1 }), phaseErrors: { hourly: "Error" } }),
    }));
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "price-corroboration", outcome: "error", error: "Error",
    }));
    expect(JSON.stringify(mocks.recordBudgetSurfaceTelemetry.mock.calls)).not.toContain("secret-token");
  });

  it.each([24, 39, 54])("refreshes DEX only on minute %s", async (minute) => {
    await runStatusSelfCheckSlot(runtime([], minute));
    expect(mocks.runPriceCorroboration).not.toHaveBeenCalled();
    expect(mocks.runPriceDexRefresh).toHaveBeenCalledOnce();
    expect(mocks.logCronEvent).toHaveBeenCalledOnce();
    expect(mocks.recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "ok" }));
  });
});
