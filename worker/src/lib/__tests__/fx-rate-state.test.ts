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

  it("tolerates 1 missed business-daily publish for market holidays", () => {
    // Good Friday 2026-04-03: latest source is Thursday 2026-04-02,
    // expected would naively be Friday, but we tolerate 1 missed day.
    vi.setSystemTime(new Date("2026-04-05T19:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedAUD: nowSec - (48 * 3600) },
        sourceModeByPeg: { peggedAUD: "live" },
        sourceCadenceByPeg: { peggedAUD: "business-daily" },
        sourceDateByPeg: { peggedAUD: "2026-04-02" },
        consecutiveFallbackRuns: 0,
      },
      { peggedAUD: 0.64 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedAUD", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("flags 2 missed business-daily publishes as degraded", () => {
    // Wednesday source date, Friday after publish window → 2 missed
    vi.setSystemTime(new Date("2026-04-10T18:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (72 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-04-08" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("degraded");
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

  it("falls back to bootstrap metadata when the meta cache is malformed", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: nowSec - 60 },
      { value: "{bad json", updatedAt: nowSec - 60 },
    );

    expect(state).not.toBeNull();
    expect(state?.usableSyncAt).toBe(nowSec - 60);
    expect(state?.mode).toBe("live");
    expect(state?.sourceUpdatedAtByPeg.peggedEUR).toBe(nowSec - 60);
    expect(state?.sourceModeByPeg.peggedEUR).toBe("live");
  });

  it("returns null when the rates cache JSON is malformed", () => {
    const state = hydrateFxRateState(
      { value: "{bad json", updatedAt: 1_700_000_000 },
      null,
    );

    expect(state).toBeNull();
  });
});
