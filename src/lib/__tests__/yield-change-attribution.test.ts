import { describe, expect, it } from "vitest";

import {
  ORGANIC_DELTA_THRESHOLD_PP,
  SOURCE_SWITCH_DELTA_THRESHOLD_PP,
  classifyApyChange,
} from "@/lib/yield-change-attribution";
import type { YieldHistoryPoint } from "@shared/types";

const NOW_MS = Date.parse("2026-05-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function point(daysAgo: number, apy: number, overrides: Partial<YieldHistoryPoint> = {}): YieldHistoryPoint {
  return {
    date: NOW_MS - daysAgo * DAY_MS,
    apy,
    apyBase: null,
    apyReward: null,
    exchangeRate: null,
    sourceTvlUsd: null,
    warningSignals: [],
    ...overrides,
  };
}

describe("classifyApyChange", () => {
  it("returns insufficient-data when history is empty", () => {
    const result = classifyApyChange({ history: [], nowMs: NOW_MS });
    expect(result.attribution).toBe("insufficient-data");
    expect(result.confidence).toBe("low");
    expect(result.largestDelta).toBeNull();
    expect(result.headline).toMatch(/not enough data/i);
  });

  it("returns insufficient-data when the largest delta is small and no decision ledger", () => {
    const history = [point(5, 5.0), point(4, 5.05), point(3, 5.0), point(2, 4.97), point(1, 5.01)];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    expect(result.attribution).toBe("insufficient-data");
    expect(result.largestDelta).not.toBeNull();
  });

  it("attributes a recent source switch with high confidence", () => {
    const history = [point(20, 4.0), point(10, 4.05), point(5, 6.1), point(4, 6.0), point(1, 6.05)];
    const result = classifyApyChange({
      history,
      decisionLedger: {
        sourceSwitch: true,
        apy30dDeltaFromPrevious: 1.8,
        previousBestSourceKey: "aave-v3",
        previousSourceLabel: "Aave",
        switchedAtMs: NOW_MS - 5 * DAY_MS,
      },
      nowMs: NOW_MS,
    });
    expect(result.attribution).toBe("source-switch");
    expect(result.confidence).toBe("high");
    expect(result.sourceSwitchDetail).toEqual({
      previousSourceKey: "aave-v3",
      previousSourceLabel: "Aave",
      apy30dDelta: 1.8,
    });
    expect(result.headline).toContain("Aave");
    expect(result.headline).toMatch(/\+1\.8pp/);
  });

  it("ignores source switch when the delta is below the threshold", () => {
    const ledger = {
      sourceSwitch: true,
      apy30dDeltaFromPrevious: SOURCE_SWITCH_DELTA_THRESHOLD_PP - 0.1,
      previousBestSourceKey: "aave-v3",
      switchedAtMs: NOW_MS - 5 * DAY_MS,
    };
    const history = [point(5, 5.0), point(1, 5.05)];
    const result = classifyApyChange({ history, decisionLedger: ledger, nowMs: NOW_MS });
    expect(result.attribution).not.toBe("source-switch");
  });

  it("ignores source switch when it falls outside the 30d window", () => {
    const ledger = {
      sourceSwitch: true,
      apy30dDeltaFromPrevious: 1.8,
      previousBestSourceKey: "aave-v3",
      switchedAtMs: NOW_MS - 60 * DAY_MS,
    };
    const history = [point(5, 5.0), point(1, 5.05)];
    const result = classifyApyChange({ history, decisionLedger: ledger, nowMs: NOW_MS });
    expect(result.attribution).not.toBe("source-switch");
  });

  it("attributes organic drift when the largest move exceeds the organic threshold without source switch", () => {
    const history = [point(10, 5.0), point(5, 5.1), point(2, 6.5), point(1, 6.55)];
    const result = classifyApyChange({ history, yieldStability: 0.8, nowMs: NOW_MS });
    expect(result.attribution).toBe("organic");
    expect(result.confidence).toBe("high");
    expect(result.headline).toMatch(/organic/i);
    expect(result.headline).toMatch(/80%/);
  });

  it("uses lower organic confidence when stability is weak", () => {
    const history = [point(10, 5.0), point(2, 7.0), point(1, 7.05)];
    const result = classifyApyChange({ history, yieldStability: 0.3, nowMs: NOW_MS });
    expect(result.attribution).toBe("organic");
    expect(result.confidence).toBe("low");
  });

  it("flags mixed attribution when both a source switch AND a non-overlapping organic move exist", () => {
    // Switch happened 14 days ago; largest organic move is at day 2 (no overlap).
    const history = [
      point(20, 4.0),
      point(15, 4.05),
      point(14, 5.0), // switch impact
      point(13, 5.05),
      point(2, 6.5), // unrelated organic spike
      point(1, 6.55),
    ];
    const result = classifyApyChange({
      history,
      decisionLedger: {
        sourceSwitch: true,
        apy30dDeltaFromPrevious: 1.0,
        previousBestSourceKey: "aave-v3",
        switchedAtMs: NOW_MS - 14 * DAY_MS,
      },
      nowMs: NOW_MS,
    });
    expect(result.attribution).toBe("mixed");
    expect(result.confidence).toBe("low");
    expect(result.headline).toMatch(/multiple drivers/i);
  });

  it("keeps source-switch attribution when the largest move overlaps the switch timestamp", () => {
    const history = [point(20, 4.0), point(15, 4.05), point(14, 6.0), point(1, 6.05)];
    const result = classifyApyChange({
      history,
      decisionLedger: {
        sourceSwitch: true,
        apy30dDeltaFromPrevious: 1.8,
        previousBestSourceKey: "aave-v3",
        switchedAtMs: NOW_MS - 14 * DAY_MS,
      },
      nowMs: NOW_MS,
    });
    expect(result.attribution).toBe("source-switch");
  });

  it("degrades gracefully when decisionLedger is absent", () => {
    const history = [point(10, 5.0), point(2, 7.0), point(1, 7.05)];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    expect(result.attribution).toBe("organic");
    // No throw, and no sourceSwitchDetail leaked through.
    expect(result.sourceSwitchDetail).toBeUndefined();
  });

  it("does not throw when history points have invalid dates or NaN APY", () => {
    const history: YieldHistoryPoint[] = [
      { date: "not-a-date", apy: 1, apyBase: null, apyReward: null, exchangeRate: null, sourceTvlUsd: null, warningSignals: [] },
      { date: NOW_MS - 5 * DAY_MS, apy: Number.NaN, apyBase: null, apyReward: null, exchangeRate: null, sourceTvlUsd: null, warningSignals: [] },
      point(2, 5.0),
      point(1, 7.0),
    ];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    expect(result.attribution).toBe("organic");
    expect(result.largestDelta?.value).toBeCloseTo(2.0);
  });

  it("treats history points outside the 30d window as ineligible for largest-delta selection", () => {
    const history = [
      point(40, 1.0),
      point(39, 9.0), // huge but outside window
      point(5, 5.0),
      point(4, 5.5),
    ];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    expect(result.largestDelta?.value).toBeCloseTo(0.5);
  });

  it("uses constants that match the documented thresholds", () => {
    expect(SOURCE_SWITCH_DELTA_THRESHOLD_PP).toBe(0.5);
    expect(ORGANIC_DELTA_THRESHOLD_PP).toBe(1.0);
  });
});
