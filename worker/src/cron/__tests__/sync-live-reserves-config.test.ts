import { describe, expect, it } from "vitest";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";

describe("live reserve execution budgets", () => {
  it("sanitizes unavailable overrides to the lease-safe defaults", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: Number.NaN, runBudgetMs: Number.POSITIVE_INFINITY,
      d1FinalizeTimeoutMs: 0, finalizationMarginMs: -1,
    })).toEqual({
      adapterTimeoutMs: 20_000, runBudgetMs: 540_000,
      d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000, minimumAttemptBudgetMs: 55_000,
    });
  });

  it("floors finite overrides and derives admission headroom rather than trusting a caller total", () => {
    expect(resolveLiveReserveSyncBudgetConfig({
      adapterTimeoutMs: 10_000.9, runBudgetMs: 400_000.9,
      d1FinalizeTimeoutMs: 5_000.9, finalizationMarginMs: 1_000.9, minimumAttemptBudgetMs: 1,
    })).toEqual({
      adapterTimeoutMs: 10_000, runBudgetMs: 400_000,
      d1FinalizeTimeoutMs: 5_000, finalizationMarginMs: 1_000, minimumAttemptBudgetMs: 16_000,
    });
  });
});
