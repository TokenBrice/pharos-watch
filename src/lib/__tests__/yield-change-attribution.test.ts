import { describe, expect, it } from "vitest";

import {
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

function hourlyPoint(day: number, hour: number, apy: number): YieldHistoryPoint {
  return point(0, apy, { date: Date.UTC(2026, 4, day, hour) });
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

  it("resamples hourly history to daily closes before applying per-day thresholds", () => {
    // Hour-over-hour swings of 3–4pp are noise; the daily closes barely move.
    const history = [
      hourlyPoint(17, 10, 5.0),
      hourlyPoint(17, 14, 8.0),
      hourlyPoint(17, 22, 5.0), // day-17 close
      hourlyPoint(18, 10, 7.5),
      hourlyPoint(18, 14, 3.5),
      hourlyPoint(18, 22, 5.05), // day-18 close
    ];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    // Fails pre-fix (B34): adjacent hourly points made the 4pp swing "organic".
    expect(result.attribution).toBe("insufficient-data");
    expect(result.largestDelta?.value).toBeCloseTo(0.05);
  });

  it("collapses same-day hourly points into one daily close", () => {
    const history = [
      hourlyPoint(17, 9, 4.0),
      hourlyPoint(18, 10, 5.0),
      hourlyPoint(18, 23, 5.5), // day-18 close supersedes the earlier 5.0
    ];
    const result = classifyApyChange({ history, nowMs: NOW_MS });
    expect(result.largestDelta?.value).toBeCloseTo(1.5); // 4.0 -> 5.5
  });

  it("attributes a real switch observed in history with high confidence (no ledger timestamp)", () => {
    const history = [
      point(6, 4.0, { sourceKey: "aave-v3", yieldSource: "Aave" }),
      point(5, 6.1, { sourceKey: "nimbus", yieldSource: "Nimbus", sourceSwitch: true }),
      point(4, 6.0, { sourceKey: "nimbus", yieldSource: "Nimbus" }),
      point(1, 6.05, { sourceKey: "nimbus", yieldSource: "Nimbus" }),
    ];
    const result = classifyApyChange({
      history,
      decisionLedger: {
        sourceSwitch: true,
        apy30dDeltaFromPrevious: 1.8,
        previousBestSourceKey: "aave-v3",
        previousSourceLabel: "Aave",
      },
      nowMs: NOW_MS,
    });
    // Fails pre-fix (B35): with switchedAtMs always null the largest daily move
    // (on the switch day) was downgraded to mixed/low confidence.
    expect(result.attribution).toBe("source-switch");
    expect(result.confidence).toBe("high");
    expect(result.headline).toContain("Aave");
  });

  it("does not treat a ledger switch without any observable switch point as recent", () => {
    const history = [point(10, 5.0), point(2, 7.0), point(1, 7.05)];
    const result = classifyApyChange({
      history,
      decisionLedger: { sourceSwitch: true, apy30dDeltaFromPrevious: 1.8 },
      nowMs: NOW_MS,
    });
    // Fails pre-fix (B35): isRecentSwitch(null) returned true, so every ledger
    // switch was treated as in-window.
    expect(result.attribution).toBe("organic");
    expect(result.sourceSwitchDetail).toBeUndefined();
  });

  it("derives the previous source identity from the history point before the switch", () => {
    const history = [
      point(6, 5.0, { sourceKey: "old-src", yieldSource: "Old Source" }),
      point(5, 5.4, { sourceKey: "new-src", yieldSource: "New Source", sourceSwitch: true }),
      point(1, 5.45, { sourceKey: "new-src", yieldSource: "New Source" }),
    ];
    const result = classifyApyChange({
      history,
      decisionLedger: { sourceSwitch: true, apy30dDeltaFromPrevious: 1.0 },
      nowMs: NOW_MS,
    });
    expect(result.attribution).toBe("source-switch");
    expect(result.sourceSwitchDetail).toEqual({
      previousSourceKey: "old-src",
      previousSourceLabel: "Old Source",
      apy30dDelta: 1.0,
    });
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

  it("ignores source switch when the ledger timestamp falls outside the 30d window", () => {
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
    // Ledger-timestamped switch 14 days ago; largest organic move at day 2.
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

  it("keeps source-switch attribution when the largest move overlaps the derived switch timestamp", () => {
    const history: YieldHistoryPoint[] = [
      { ...hourlyPoint(4, 22, 4.05), sourceKey: "aave-v3", yieldSource: "Aave" },
      { ...hourlyPoint(5, 10, 6.0), sourceKey: "nimbus", yieldSource: "Nimbus", sourceSwitch: true },
      point(1, 6.05),
    ];
    const result = classifyApyChange({
      history,
      decisionLedger: { sourceSwitch: true, apy30dDeltaFromPrevious: 1.8 },
      nowMs: NOW_MS,
    });
    // Day closes: 4.05 -> 6.0 on the switch day; the 1.95pp move sits on the
    // switch timestamp, so the overlap guard keeps source-switch (not mixed).
    expect(result.attribution).toBe("source-switch");
    expect(result.confidence).toBe("high");
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
});
