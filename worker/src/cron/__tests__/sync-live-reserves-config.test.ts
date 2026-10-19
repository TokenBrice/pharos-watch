import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_CONTINUATION_BUDGETS, LIVE_RESERVE_SLICE_COST, resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";

describe("live reserve execution budgets", () => {
  it("sanitizes unavailable overrides to the lease-safe defaults", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: Number.NaN, runBudgetMs: Number.POSITIVE_INFINITY,
      d1FinalizeTimeoutMs: 0, finalizationMarginMs: -1,
    })).toEqual({
      adapterTimeoutMs: 20_000, runBudgetMs: 540_000,
      d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000, minimumAttemptBudgetMs: 55_000,
      maxCoinsPerSlice: 1933,
    });
  });

  it("floors finite overrides and derives admission headroom rather than trusting a caller total", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: 10_000.9, runBudgetMs: 400_000.9,
      d1FinalizeTimeoutMs: 5_000.9, finalizationMarginMs: 1_000.9, minimumAttemptBudgetMs: 1,
    })).toEqual({
      adapterTimeoutMs: 10_000, runBudgetMs: 400_000,
      d1FinalizeTimeoutMs: 5_000, finalizationMarginMs: 1_000, minimumAttemptBudgetMs: 16_000,
      maxCoinsPerSlice: 1933,
    });
  });

  it("extends continuation wall time without raising the reviewed 125-coin CPU cap", () => {
    const config = resolveLiveReserveSyncBudgetConfig(LIVE_RESERVE_CONTINUATION_BUDGETS);
    expect(config.runBudgetMs).toBe(300_000);
    expect(config.minimumAttemptBudgetMs).toBe(55_000);
    expect(config.adapterTimeoutMs).toBe(20_000);
    expect(config.d1FinalizeTimeoutMs).toBe(30_000);
    expect(config.finalizationMarginMs).toBe(5_000);
    expect(config.maxCoinsPerSlice).toBe(125);
    expect(config.maxCoinsPerSlice * LIVE_RESERVE_SLICE_COST.wallMsPerCoin + config.minimumAttemptBudgetMs)
      .toBeLessThanOrEqual(config.runBudgetMs);
    expect(config.maxCoinsPerSlice * LIVE_RESERVE_SLICE_COST.cpuMsPerCoin + LIVE_RESERVE_SLICE_COST.cpuMarginMs)
      .toBeLessThan(30_000);
  });
});
