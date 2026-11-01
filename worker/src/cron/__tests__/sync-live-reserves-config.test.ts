import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_CONTINUATION_BUDGETS,
  LIVE_RESERVE_PRODUCER_BUDGETS,
  LIVE_RESERVE_PRODUCER_WORK_BUDGET_RATIO,
  LIVE_RESERVE_SLICE_COST,
  resolveLiveReserveSyncBudgetConfig,
} from "../sync-live-reserves-config";

describe("live reserve execution budgets", () => {
  it("sanitizes unavailable overrides to the lease-safe defaults", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: Number.NaN, runBudgetMs: Number.POSITIVE_INFINITY,
      d1FinalizeTimeoutMs: 0, finalizationMarginMs: -1,
    })).toEqual({
      adapterTimeoutMs: 20_000, runBudgetMs: 540_000, workBudgetMs: 540_000,
      d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000, minimumAttemptBudgetMs: 55_000,
      maxCoinsPerSlice: 1933,
    });
  });

  it("floors finite overrides and derives admission headroom rather than trusting a caller total", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: 10_000.9, runBudgetMs: 400_000.9, workBudgetMs: 500_000.9,
      d1FinalizeTimeoutMs: 5_000.9, finalizationMarginMs: 1_000.9, minimumAttemptBudgetMs: 1,
    })).toEqual({
      adapterTimeoutMs: 10_000, runBudgetMs: 400_000, workBudgetMs: 400_000,
      d1FinalizeTimeoutMs: 5_000, finalizationMarginMs: 1_000, minimumAttemptBudgetMs: 16_000,
      maxCoinsPerSlice: 1933,
    });
  });

  it("yields a producer slice at 60% of its run budget, keeping the other 40% as growth headroom", () => {
    const config = resolveLiveReserveSyncBudgetConfig(LIVE_RESERVE_PRODUCER_BUDGETS);
    expect(config.runBudgetMs).toBe(540_000);
    expect(config.workBudgetMs).toBe(289_000);
    // The finalization tail is charged to the admitted 60%, so the whole slice
    // cannot consume the reserved headroom.
    const sliceWorstCaseMs = config.workBudgetMs + config.d1FinalizeTimeoutMs + config.finalizationMarginMs;
    expect(sliceWorstCaseMs).toBe(Math.floor(config.runBudgetMs * LIVE_RESERVE_PRODUCER_WORK_BUDGET_RATIO));
    expect((config.runBudgetMs - sliceWorstCaseMs) / config.runBudgetMs).toBeGreaterThanOrEqual(0.4);
    // More than the ~30-coin cohort growth that already risks truncation.
    expect(Math.floor((config.runBudgetMs - sliceWorstCaseMs) / LIVE_RESERVE_SLICE_COST.wallMsPerCoin))
      .toBeGreaterThan(30);
    // An inherited event deadline still bounds admission below the producer horizon.
    expect(resolveLiveReserveSyncBudgetConfig({ ...LIVE_RESERVE_PRODUCER_BUDGETS, runBudgetMs: 200_000 }).workBudgetMs)
      .toBe(200_000);
  });

  it("extends continuation wall time without raising the reviewed 125-coin CPU cap", () => {
    const config = resolveLiveReserveSyncBudgetConfig(LIVE_RESERVE_CONTINUATION_BUDGETS);
    expect(config.runBudgetMs).toBe(300_000);
    // A continuation slice owns its whole reviewed budget; the coin cap bounds it.
    expect(config.workBudgetMs).toBe(300_000);
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
