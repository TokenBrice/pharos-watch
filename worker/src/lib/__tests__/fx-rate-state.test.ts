import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFxCacheStatus, getFxReferenceTypeFromState, hydrateFxRateState } from "../fx-rate-state";

function buildState(meta: Record<string, unknown>, rates: Record<string, number>) {
  const nowSec = Math.floor(Date.now() / 1000);
  return hydrateFxRateState(
    { value: JSON.stringify(rates), updatedAt: nowSec - 60 },
    { value: JSON.stringify(meta), updatedAt: nowSec - 60 },
  );
}

describe("fx-rate-state cadence-aware freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps business-daily references fresh before the next publish window", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (16 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-03-10" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("keeps Friday business-daily references fresh through the weekend", () => {
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (44 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-03-13" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("keeps intraday degradation visible in health while treating it as stale for strict reference checks", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "cached-fallback",
        sourceUpdatedAtByPeg: { peggedGOLD: nowSec - (8 * 3600) },
        sourceModeByPeg: { peggedGOLD: "cached" },
        sourceCadenceByPeg: { peggedGOLD: "intraday" },
        sourceDateByPeg: { peggedGOLD: null },
        consecutiveFallbackRuns: 1,
      },
      { peggedGOLD: 2900 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedGOLD", 6 * 3600, nowSec)).toBe("stale");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("degraded");
  });
});
