import { describe, it, expect } from "vitest";
import { computePegScore, coinTrackingStart, PEG_SCORE_LOOKBACK_SEC } from "../peg-score";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

describe("coinTrackingStart", () => {
  const fourYearsAgo = NOW - PEG_SCORE_LOOKBACK_SEC;

  it("returns null when no data and no firstSeen", () => {
    expect(coinTrackingStart([], fourYearsAgo)).toBeNull();
  });

  it("uses firstSeenSec when available", () => {
    const firstSeen = NOW - 365 * DAY;
    expect(coinTrackingStart([], fourYearsAgo, firstSeen)).toBe(firstSeen);
  });

  it("clamps to fourYearsAgo if firstSeen is earlier", () => {
    const veryOld = NOW - 10 * 365 * DAY;
    expect(coinTrackingStart([], fourYearsAgo, veryOld)).toBe(fourYearsAgo);
  });
});

describe("computePegScore", () => {
  it("returns null for insufficient tracking (< 7 days)", () => {
    const start = NOW - 3 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBeNull();
  });

  it("returns a score for a coin with 7+ days of tracking", () => {
    const start = NOW - 10 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBe(100);
  });

  it("returns 100 for a coin with no depeg events over 30+ days", () => {
    const start = NOW - 60 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBe(100);
    expect(result.pegPct).toBeCloseTo(100);
    expect(result.severityScore).toBeCloseTo(100);
  });

  it("penalizes active depeg events", () => {
    const start = NOW - 90 * DAY;
    const events = [{
      startedAt: NOW - DAY,
      endedAt: null,
      peakDeviationBps: 500,
      direction: "below" as const,
    }];
    const result = computePegScore(events as never, start, NOW);
    expect(result.pegScore).toBeLessThan(100);
    expect(result.activeDepeg).toBe(true);
  });

  it("weights recent events more heavily than old ones", () => {
    const start = NOW - 365 * DAY;
    const recentEvent = [{
      startedAt: NOW - 30 * DAY,
      endedAt: NOW - 20 * DAY,
      peakDeviationBps: 5000,
      direction: "below" as const,
    }];
    const oldEvent = [{
      startedAt: NOW - 350 * DAY,
      endedAt: NOW - 340 * DAY,
      peakDeviationBps: 5000,
      direction: "below" as const,
    }];
    const recentResult = computePegScore(recentEvent as never, start, NOW);
    const oldResult = computePegScore(oldEvent as never, start, NOW);
    expect(recentResult.pegScore!).toBeLessThan(oldResult.pegScore!);
  });

  it("handles NaN peakDeviationBps without producing NaN score", () => {
    const start = NOW - 90 * DAY;
    const events = [
      {
        startedAt: NOW - 30 * DAY,
        endedAt: NOW - 29 * DAY,
        peakDeviationBps: NaN,
        direction: "below" as const,
      },
      {
        startedAt: NOW - 20 * DAY,
        endedAt: NOW - 19 * DAY,
        peakDeviationBps: 200,
        direction: "below" as const,
      },
    ];
    const result = computePegScore(events as never, start, NOW);
    // Score must be a finite number or null — never NaN
    if (result.pegScore !== null) {
      expect(Number.isFinite(result.pegScore)).toBe(true);
    }
  });
});
