import { describe, it, expect, vi } from "vitest";
import { mergeDepegSeconds, worstDeviation } from "@shared/lib/peg-utils";
import { coinTrackingStart, computePegScore, computePegScoreWithWindow } from "@shared/lib/peg-score";
import { computePegStability } from "../peg-stability";
import type { DepegEvent } from "@shared/types";
import { DAY_SECONDS } from "@shared/lib/time-constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal DepegEvent with sensible defaults. */
function makeEvent(overrides: Partial<DepegEvent> & Pick<DepegEvent, "startedAt" | "peakDeviationBps">): DepegEvent {
  return {
    id: 1,
    stablecoinId: "test-coin",
    symbol: "TST",
    pegType: "USD",
    direction: overrides.peakDeviationBps < 0 ? "below" : "above",
    startPrice: 1.0,
    peakPrice: null,
    recoveryPrice: null,
    pegReference: 1.0,
    source: "live",
    endedAt: null,
    ...overrides,
  };
}

const YEAR = 365.25 * DAY_SECONDS;

// ---------------------------------------------------------------------------
// mergeDepegSeconds
// ---------------------------------------------------------------------------
describe("mergeDepegSeconds", () => {
  it("returns 0 for an empty events array", () => {
    expect(mergeDepegSeconds([], 0, 1000)).toBe(0);
  });

  it("returns duration of a single closed interval", () => {
    const events = [makeEvent({ startedAt: 100, endedAt: 500, peakDeviationBps: -200 })];
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(400);
  });

  it("clamps an open-ended event to the 'now' boundary", () => {
    const events = [makeEvent({ startedAt: 100, endedAt: null, peakDeviationBps: -200 })];
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(900); // 100..1000
  });

  it("clamps event start to windowStart", () => {
    const events = [makeEvent({ startedAt: 50, endedAt: 300, peakDeviationBps: -200 })];
    // windowStart=100, so effective interval is 100..300
    expect(mergeDepegSeconds(events, 100, 1000)).toBe(200);
  });

  it("filters out intervals that end before windowStart", () => {
    const events = [makeEvent({ startedAt: 10, endedAt: 50, peakDeviationBps: -200 })];
    // windowStart=100 means clamped start=100, end=50 => filtered (end <= start)
    expect(mergeDepegSeconds(events, 100, 1000)).toBe(0);
  });

  it("sums non-overlapping intervals", () => {
    const events = [
      makeEvent({ startedAt: 100, endedAt: 200, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 400, endedAt: 500, peakDeviationBps: -300 }),
    ];
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(200); // 100 + 100
  });

  it("merges overlapping intervals", () => {
    const events = [
      makeEvent({ startedAt: 100, endedAt: 400, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 300, endedAt: 600, peakDeviationBps: -300 }),
    ];
    // Merged: 100..600 = 500
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(500);
  });

  it("merges adjacent intervals (touching boundaries)", () => {
    const events = [
      makeEvent({ startedAt: 100, endedAt: 300, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 300, endedAt: 500, peakDeviationBps: -300 }),
    ];
    // 300 <= 300 so they merge: 100..500 = 400
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(400);
  });

  it("handles fully nested intervals", () => {
    const events = [
      makeEvent({ startedAt: 100, endedAt: 600, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 200, endedAt: 400, peakDeviationBps: -300 }),
    ];
    // Inner is fully inside outer: merged = 100..600 = 500
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(500);
  });

  it("merges multiple overlapping intervals out of order", () => {
    const events = [
      makeEvent({ startedAt: 500, endedAt: 700, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 100, endedAt: 300, peakDeviationBps: -300 }),
      makeEvent({ startedAt: 250, endedAt: 550, peakDeviationBps: -250 }),
    ];
    // Sorted: [100,300], [250,550], [500,700]
    // Merge: 100..300 overlaps with 250..550 => 100..550, overlaps with 500..700 => 100..700 = 600
    expect(mergeDepegSeconds(events, 0, 1000)).toBe(600);
  });

  it("clamps both start and end to window boundaries", () => {
    const events = [makeEvent({ startedAt: 50, endedAt: null, peakDeviationBps: -200 })];
    // windowStart=200, now=800 => clamped to 200..800 = 600
    expect(mergeDepegSeconds(events, 200, 800)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// worstDeviation
// ---------------------------------------------------------------------------
describe("worstDeviation", () => {
  it("returns null for empty events array", () => {
    expect(worstDeviation([])).toBeNull();
  });

  it("returns the peakDeviationBps of a single event", () => {
    const events = [makeEvent({ startedAt: 100, peakDeviationBps: -350 })];
    expect(worstDeviation(events)).toBe(-350);
  });

  it("returns the event with the largest absolute deviation (negative)", () => {
    const events = [
      makeEvent({ startedAt: 100, peakDeviationBps: -200 }),
      makeEvent({ startedAt: 200, peakDeviationBps: -500 }),
      makeEvent({ startedAt: 300, peakDeviationBps: -100 }),
    ];
    expect(worstDeviation(events)).toBe(-500);
  });

  it("returns the event with the largest absolute deviation (positive)", () => {
    const events = [
      makeEvent({ startedAt: 100, peakDeviationBps: 200 }),
      makeEvent({ startedAt: 200, peakDeviationBps: 600 }),
      makeEvent({ startedAt: 300, peakDeviationBps: -100 }),
    ];
    expect(worstDeviation(events)).toBe(600);
  });

  it("compares absolute values across positive and negative deviations", () => {
    const events = [
      makeEvent({ startedAt: 100, peakDeviationBps: 300 }),
      makeEvent({ startedAt: 200, peakDeviationBps: -400 }),
    ];
    // |-400| > |300|, so returns -400
    expect(worstDeviation(events)).toBe(-400);
  });

  it("keeps the signed value even when comparing absolutes", () => {
    const events = [
      makeEvent({ startedAt: 100, peakDeviationBps: -100 }),
      makeEvent({ startedAt: 200, peakDeviationBps: 100 }),
    ];
    // Same absolute value, first one wins (no override when equal)
    expect(worstDeviation(events)).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// computePegScore
// ---------------------------------------------------------------------------
describe("computePegScore", () => {
  const NOW = 1_700_000_000; // fixed "now" for deterministic tests

  it("returns null pegScore and defaults when no events and no tracking start", () => {
    const result = computePegScore([], null, NOW);
    expect(result.pegScore).toBeNull();
    expect(result.pegPct).toBe(100);
    expect(result.severityScore).toBe(100);
    expect(result.spreadPenalty).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.worstDeviationBps).toBeNull();
    expect(result.activeDepeg).toBe(false);
    expect(result.lastEventAt).toBeNull();
    expect(result.trackingSpanDays).toBe(0);
  });

  it("returns 100 for no events with sufficient tracking history", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS; // 1 year ago
    const result = computePegScore([], trackingStart, NOW);
    expect(result.pegScore).toBe(100);
    expect(result.pegPct).toBe(100);
    expect(result.severityScore).toBe(100);
    expect(result.spreadPenalty).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.activeDepeg).toBe(false);
  });

  it("returns null pegScore when tracking span is < 7 days", () => {
    const trackingStart = NOW - 3 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 2 * DAY_SECONDS, endedAt: NOW - 1 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // Score is null due to insufficient data, but other metrics are populated
    expect(result.pegScore).toBeNull();
    expect(result.pegPct).toBeGreaterThan(0);
    expect(result.eventCount).toBe(1);
  });

  it("returns a score for coins with 7-30 days of tracking (early score)", () => {
    const trackingStart = NOW - 20 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 10 * DAY_SECONDS, endedAt: NOW - 9 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // Score is computed (not null) even in the 7-30 day window
    expect(result.pegScore).not.toBeNull();
    expect(result.pegPct).toBeGreaterThan(0);
    expect(result.eventCount).toBe(1);
  });

  it("calculates pegPct correctly for a single closed depeg", () => {
    const trackingStart = NOW - 100 * DAY_SECONDS;
    // 10-day depeg in a 100-day window => 90% peg time
    const events = [
      makeEvent({ startedAt: NOW - 50 * DAY_SECONDS, endedAt: NOW - 40 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.pegPct).toBeCloseTo(90, 0);
  });

  it("applies severity penalty based on peak deviation, duration, and recency", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // A recent 30-day event at 500 bps
    const events = [
      makeEvent({
        startedAt: NOW - 35 * DAY_SECONDS,
        endedAt: NOW - 5 * DAY_SECONDS,
        peakDeviationBps: -500,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // Severity penalty: (500/100) * (30/30) * recency where recency = 1/(1 + ~0.096) ~ 0.91
    // totalPenalty ~ 5 * 1 * 0.91 = 4.56, severityScore ~ 95.4
    expect(result.severityScore).toBeGreaterThan(90);
    expect(result.severityScore).toBeLessThan(100);
    // pegScore should be well above 0 but below 100
    expect(result.pegScore).toBeGreaterThan(0);
    expect(result.pegScore).toBeLessThan(100);
  });

  it("caps event duration at 90 days for severity calculation", () => {
    const trackingStart = NOW - 2 * 365 * DAY_SECONDS;
    // A 180-day depeg (capped to 90 days for severity)
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 20 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // Duration capped at 90, not 180
    // penalty = (300/100) * (90/30) * recency
    // yearsAgo ~ 200/365.25 ~ 0.547, recency ~ 1/(1+0.547) ~ 0.646
    // penalty ~ 3 * 3 * 0.646 ~ 5.8
    expect(result.severityScore).toBeCloseTo(100 - 5.8, 0);
  });

  it("applies recency weighting: recent events penalize more than old ones", () => {
    const trackingStart = NOW - 4 * 365 * DAY_SECONDS;
    // Same event parameters, one recent and one old
    const recentEvent = makeEvent({
      startedAt: NOW - 30 * DAY_SECONDS,
      endedAt: NOW - 20 * DAY_SECONDS,
      peakDeviationBps: -500,
    });
    const oldEvent = makeEvent({
      startedAt: NOW - 3 * 365 * DAY_SECONDS,
      endedAt: NOW - 3 * 365 * DAY_SECONDS +10 * DAY_SECONDS,
      peakDeviationBps: -500,
    });

    const recentResult = computePegScore([recentEvent], trackingStart, NOW);
    const oldResult = computePegScore([oldEvent], trackingStart, NOW);

    // The recent event should produce a lower severity score (more penalty)
    expect(recentResult.severityScore).toBeLessThan(oldResult.severityScore);
  });

  it("calculates spread penalty for erratic depeg magnitudes", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // Two events with very different magnitudes => high stddev => spread penalty
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 195 * DAY_SECONDS,
        peakDeviationBps: -100,
      }),
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 95 * DAY_SECONDS,
        peakDeviationBps: -2000,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.spreadPenalty).toBeGreaterThan(0);
    // spreadPenalty = min(15, (stddev/1000)*15)
    // mean = (100+2000)/2 = 1050, variance = ((100-1050)^2 + (2000-1050)^2)/2 = 902500
    // stddev = 950, penalty = min(15, (950/1000)*15) = min(15, 14.25) = 14.25
    expect(result.spreadPenalty).toBeCloseTo(14.25, 1);
  });

  it("spread penalty is 0 for a single event", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 95 * DAY_SECONDS,
        peakDeviationBps: -500,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.spreadPenalty).toBe(0);
  });

  it("spread penalty is 0 when all events have the same magnitude", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 195 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 95 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.spreadPenalty).toBe(0);
  });

  it("spread penalty is capped at 15", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // Extremely different magnitudes => stddev >> 1000
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 195 * DAY_SECONDS,
        peakDeviationBps: -50,
      }),
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 95 * DAY_SECONDS,
        peakDeviationBps: -10000,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.spreadPenalty).toBe(15);
  });

  it("applies active depeg penalty for ongoing events", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 5 * DAY_SECONDS,
        endedAt: null, // ongoing
        peakDeviationBps: -2000,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.activeDepeg).toBe(true);
    // Active penalty = min(50, max(2, 2000/200)) = min(50, 10) = 10
    // The score should be lower due to the penalty
    expect(result.pegScore).not.toBeNull();
  });

  it("active depeg penalty has a floor of 2 and cap of 50", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;

    // Small depeg: penalty = max(2, 100/200) = max(2, 0.5) = 2
    const smallEvent = makeEvent({
      startedAt: NOW - 1 * DAY_SECONDS,
      endedAt: null,
      peakDeviationBps: -100,
    });
    const smallResult = computePegScore([smallEvent], trackingStart, NOW);

    // Huge depeg: penalty = min(50, max(2, 15000/200)) = min(50, 75) = 50
    const hugeEvent = makeEvent({
      startedAt: NOW - 1 * DAY_SECONDS,
      endedAt: null,
      peakDeviationBps: -15000,
    });
    const hugeResult = computePegScore([hugeEvent], trackingStart, NOW);

    // Compute expected scores manually
    // Both have same pegPct and similar severity, so difference comes from active penalty
    // Small should score higher than huge due to smaller active penalty
    expect(smallResult.pegScore!).toBeGreaterThan(hugeResult.pegScore!);
  });

  it("composite score is clamped to [0, 100]", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // No events => raw = 0.5*100 + 0.5*100 - 0 - 0 = 100
    const perfectResult = computePegScore([], trackingStart, NOW);
    expect(perfectResult.pegScore).toBe(100);

    // Catastrophic depeg to force score below 0
    const events = [
      makeEvent({
        startedAt: trackingStart,
        endedAt: null,
        peakDeviationBps: -10000,
      }),
    ];
    const badResult = computePegScore(events, trackingStart, NOW);
    expect(badResult.pegScore).toBeGreaterThanOrEqual(0);
  });

  it("pegScore is rounded to the nearest integer", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 50 * DAY_SECONDS,
        endedAt: NOW - 48 * DAY_SECONDS,
        peakDeviationBps: -200,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.pegScore).not.toBeNull();
    expect(Number.isInteger(result.pegScore!)).toBe(true);
  });

  it("reports correct eventCount", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 300 * DAY_SECONDS, endedAt: NOW - 295 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -300 }),
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 95 * DAY_SECONDS, peakDeviationBps: -150 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.eventCount).toBe(3);
  });

  it("reports worstDeviationBps from events", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 95 * DAY_SECONDS, peakDeviationBps: -800 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.worstDeviationBps).toBe(-800);
  });

  it("reports lastEventAt as the most recent startedAt", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 50 * DAY_SECONDS, endedAt: NOW - 45 * DAY_SECONDS, peakDeviationBps: -300 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.lastEventAt).toBe(NOW - 50 * DAY_SECONDS);
  });

  it("reports trackingSpanDays as floored days", () => {
    const trackingStart = NOW - 100 * DAY_SECONDS - 43200; // 100.5 days
    const result = computePegScore([], trackingStart, NOW);
    expect(result.trackingSpanDays).toBe(100);
  });

  it("uses earliest event as tracking start when trackingStartSec is null", () => {
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 95 * DAY_SECONDS, peakDeviationBps: -300 }),
    ];
    const result = computePegScore(events, null, NOW);
    // Tracking starts from earliest event: NOW - 200*DAY_SECONDS
    expect(result.trackingSpanDays).toBe(200);
  });

  it("scores a mild depeg in the 80-99 range", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // 15-day mild depeg (400 bps) in 1 year of history — noticeable but not catastrophic
    const events = [
      makeEvent({
        startedAt: NOW - 60 * DAY_SECONDS,
        endedAt: NOW - 45 * DAY_SECONDS,
        peakDeviationBps: -400,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.pegScore).not.toBeNull();
    expect(result.pegScore!).toBeGreaterThanOrEqual(80);
    expect(result.pegScore!).toBeLessThanOrEqual(99);
  });

  it("scores a severe/long depeg much lower", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // 30-day severe depeg (5000 bps) fairly recent
    const events = [
      makeEvent({
        startedAt: NOW - 60 * DAY_SECONDS,
        endedAt: NOW - 30 * DAY_SECONDS,
        peakDeviationBps: -5000,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    expect(result.pegScore).not.toBeNull();
    expect(result.pegScore!).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// coinTrackingStart
// ---------------------------------------------------------------------------
describe("coinTrackingStart", () => {
  const NOW = 1_700_000_000;
  const FOUR_YEARS_AGO = NOW - 4 * 365.25 * DAY_SECONDS;

  it("returns null when no events and no firstSeen (insufficient data)", () => {
    expect(coinTrackingStart([], FOUR_YEARS_AGO)).toBeNull();
  });

  it("returns firstSeen when coin is younger than 4 years", () => {
    const firstSeen = NOW - 200 * DAY_SECONDS;
    expect(coinTrackingStart([], FOUR_YEARS_AGO, firstSeen)).toBe(firstSeen);
  });

  it("returns fourYearsAgo when firstSeen is older than 4 years", () => {
    const firstSeen = NOW - 10 * YEAR;
    expect(coinTrackingStart([], FOUR_YEARS_AGO, firstSeen)).toBe(FOUR_YEARS_AGO);
  });

  it("uses earliest event when no firstSeen provided", () => {
    const events = [
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 99 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 50 * DAY_SECONDS, endedAt: NOW - 49 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    expect(coinTrackingStart(events, FOUR_YEARS_AGO)).toBe(NOW - 100 * DAY_SECONDS);
  });

  it("prefers firstSeen over earliest event when firstSeen is older", () => {
    const firstSeen = NOW - 300 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 99 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    // firstSeen (300d) > fourYearsAgo → use firstSeen
    expect(coinTrackingStart(events, FOUR_YEARS_AGO, firstSeen)).toBe(firstSeen);
  });
});

// ---------------------------------------------------------------------------
// computePegScoreWithWindow
// ---------------------------------------------------------------------------
describe("computePegScoreWithWindow", () => {
  const NOW = 1_700_000_000;

  it("returns null for NAV tokens", () => {
    const result = computePegScoreWithWindow(true, [], NOW - 30 * DAY_SECONDS);
    expect(result).toBeNull();
  });

  it("returns null when events are missing", () => {
    const result = computePegScoreWithWindow(false, null, NOW - 30 * DAY_SECONDS);
    expect(result).toBeNull();
  });

  it("uses earliestTrackingDate when provided", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const events = [
      makeEvent({ startedAt: NOW - 10 * DAY_SECONDS, endedAt: NOW - 9 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computePegScoreWithWindow(false, events, NOW - 120 * DAY_SECONDS);

    expect(result).not.toBeNull();
    expect(result!.eventCount).toBe(1);
    expect(result!.trackingSpanDays).toBe(120);
    expect(result!.worstDeviationBps).toBe(-200);
    nowSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Severity magnitude floor
// ---------------------------------------------------------------------------
describe("severity magnitude floor", () => {
  const NOW = 1_700_000_000;

  it("short high-magnitude events carry meaningful penalty via floor", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    // A single 2-hour 400bps event — without floor this is nearly invisible
    const events = [
      makeEvent({
        startedAt: NOW - 10 * DAY_SECONDS,
        endedAt: NOW - 10 * DAY_SECONDS +2 * 3600,
        peakDeviationBps: -400,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // magnitudeFloor = (400/2000) * recency ≈ 0.2 * ~0.97 ≈ 0.19
    // durationPenalty = (4) * (0.083/30) * 0.97 ≈ 0.011
    // Floor should dominate: severityScore ≈ 99.8 not 99.99
    expect(result.severityScore).toBeLessThan(99.9);
  });

  it("many short micro-depegs accumulate a significant penalty", () => {
    const trackingStart = NOW - 30 * DAY_SECONDS;
    // 50 events, each 1 hour, 300bps, spread over 30 days
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        id: i,
        startedAt: NOW - 30 * DAY_SECONDS +i * 12 * 3600,
        endedAt: NOW - 30 * DAY_SECONDS +i * 12 * 3600 + 3600,
        peakDeviationBps: -300,
      }),
    );
    const result = computePegScore(events, trackingStart, NOW);
    // Each event: magnitudeFloor = 300/2000 * ~1 = 0.15
    // 50 * 0.15 = 7.5 total penalty → severityScore ≈ 92.5
    expect(result.severityScore).toBeLessThan(95);
    expect(result.severityScore).toBeGreaterThan(85);
  });

  it("floor does not affect long events where duration penalty already dominates", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 60 * DAY_SECONDS,
        endedAt: NOW - 30 * DAY_SECONDS,
        peakDeviationBps: -500,
      }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // durationPenalty = (5) * (30/30) * recency ≈ 5 * 0.86 = 4.3
    // magnitudeFloor = 500/2000 * 0.86 = 0.22
    // Duration penalty dominates
    expect(result.severityScore).toBeGreaterThan(90);
    expect(result.severityScore).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Active depeg penalty scaling
// ---------------------------------------------------------------------------
describe("active depeg penalty scaling", () => {
  const NOW = 1_700_000_000;

  it("floor is 5 for threshold-level depegs (100 bps)", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - DAY_SECONDS, endedAt: null, peakDeviationBps: -100 }),
    ];
    const noDepegResult = computePegScore([], trackingStart, NOW);
    const result = computePegScore(events, trackingStart, NOW);
    // Active penalty = max(5, 100/50) = max(5, 2) = 5
    // Score difference should be ≈5 points (plus some pegPct/severity effect)
    expect(noDepegResult.pegScore! - result.pegScore!).toBeGreaterThanOrEqual(5);
  });

  it("moderate depeg (500 bps) gets penalty of 10", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - DAY_SECONDS, endedAt: null, peakDeviationBps: -500 }),
    ];
    const noDepegResult = computePegScore([], trackingStart, NOW);
    const result = computePegScore(events, trackingStart, NOW);
    // Active penalty = max(5, 500/50) = 10
    expect(noDepegResult.pegScore! - result.pegScore!).toBeGreaterThanOrEqual(10);
  });

  it("severe depeg (2500+ bps) hits the 50-point cap", () => {
    const trackingStart = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - DAY_SECONDS, endedAt: null, peakDeviationBps: -5000 }),
    ];
    const result = computePegScore(events, trackingStart, NOW);
    // Active penalty capped at 50
    expect(result.pegScore!).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Young coin with chronic depegs (cUSD-like scenario)
// ---------------------------------------------------------------------------
describe("young coin with chronic depegs", () => {
  const NOW = 1_700_000_000;

  it("scores much lower when tracking window matches actual coin age", () => {
    // Simulate a 30-day-old coin that depegs for 2 hours every 6 hours
    const coinAge = 30 * DAY_SECONDS;
    const trackingStart = NOW - coinAge;
    const events: DepegEvent[] = [];
    for (let i = 0; i < 120; i++) {
      events.push(makeEvent({
        id: i,
        startedAt: trackingStart + i * 6 * 3600,
        endedAt: trackingStart + i * 6 * 3600 + 2 * 3600,
        peakDeviationBps: -350,
      }));
    }
    const result = computePegScore(events, trackingStart, NOW);

    // With proper 30-day window:
    // pegPct ≈ 67% (depegged ~1/3 of the time)
    // severityScore is reduced by 120 events × floor penalty
    // Should score well below 80
    expect(result.pegScore).not.toBeNull();
    expect(result.pegScore!).toBeLessThan(80);
  });

  it("same events diluted over 4-year window would score much higher", () => {
    // Same events but with a 4-year tracking start (the old bug)
    const coinAge = 30 * DAY_SECONDS;
    const fourYearStart = NOW - 4 * YEAR;
    const events: DepegEvent[] = [];
    for (let i = 0; i < 120; i++) {
      events.push(makeEvent({
        id: i,
        startedAt: NOW - coinAge + i * 6 * 3600,
        endedAt: NOW - coinAge + i * 6 * 3600 + 2 * 3600,
        peakDeviationBps: -350,
      }));
    }

    const correctResult = computePegScore(events, NOW - coinAge, NOW);
    const dilutedResult = computePegScore(events, fourYearStart, NOW);

    // The diluted (4-year window) version should score significantly higher
    expect(dilutedResult.pegScore!).toBeGreaterThan(correctResult.pegScore! + 15);
  });
});

// ---------------------------------------------------------------------------
// computePegStability
// ---------------------------------------------------------------------------
describe("computePegStability", () => {
  const NOW = 1_700_000_000;

  it("returns null when no earliestDate and no events", () => {
    const result = computePegStability([], null, NOW);
    expect(result).toBeNull();
  });

  it("returns null when historySpanSec <= 0", () => {
    // earliestDate is in the future
    const futureDate = NOW + 1000;
    const result = computePegStability([], futureDate, NOW);
    expect(result).toBeNull();
  });

  it("returns 100% pegPct when no depeg events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBe(100);
    expect(result!.eventCount).toBe(0);
    expect(result!.depeggedNow).toBe(false);
    expect(result!.worstDeviationBps).toBeNull();
  });

  it("calculates pegPct correctly with one closed depeg event", () => {
    const earliestDate = NOW - 100 * DAY_SECONDS;
    // 10-day depeg in 100-day window => 90% at peg
    const events = [
      makeEvent({
        startedAt: NOW - 50 * DAY_SECONDS,
        endedAt: NOW - 40 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBeCloseTo(90, 0);
  });

  it("marks limited=true when tracking span is under 7 days", () => {
    const earliestDate = NOW - 3 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.limited).toBe(true);
  });

  it("marks limited=false when tracking span is 7+ days", () => {
    const earliestDate = NOW - 10 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.limited).toBe(false);
  });

  it("detects depeggedNow when there is an ongoing event", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 5 * DAY_SECONDS,
        endedAt: null,
        peakDeviationBps: -500,
      }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(true);
    expect(result!.currentStreakDays).toBeNull();
  });

  it("calculates currentStreakDays since last closed event", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 90 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(false);
    expect(result!.currentStreakDays).toBe(90); // 90 days since endedAt
  });

  it("returns the most recent endedAt for currentStreakDays with multiple events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 190 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 50 * DAY_SECONDS,
        peakDeviationBps: -200,
      }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.currentStreakDays).toBe(50); // 50 days since most recent endedAt
  });

  it("reports worstDeviationBps from events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 95 * DAY_SECONDS, peakDeviationBps: -700 }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.worstDeviationBps).toBe(-700);
  });

  it("reports correct eventCount", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 300 * DAY_SECONDS, endedAt: NOW - 295 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -300 }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.eventCount).toBe(2);
  });

  it("falls back to earliest event when earliestDate is null", () => {
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computePegStability(events, null, NOW);
    expect(result).not.toBeNull();
    // Tracking starts from the event's startedAt
    expect(result!.pegPct).toBeGreaterThan(0);
  });

  it("handles fully depegged scenario (depeg spans entire window)", () => {
    const earliestDate = NOW - 100 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: null, // ongoing, covers entire window
        peakDeviationBps: -5000,
      }),
    ];
    const result = computePegStability(events, earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBeCloseTo(0, 0);
    expect(result!.depeggedNow).toBe(true);
  });

  // --- formatTrackingSpan (tested indirectly through computePegStability) ---

  it("formats tracking span as days when < 30 days", () => {
    const earliestDate = NOW - 15 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("15d");
  });

  it("formats tracking span as months when < 12 months", () => {
    const earliestDate = NOW - 90 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    // 90 days / 30.44 ~ 2.95 months, floored to 2
    expect(result!.trackingSpan).toBe("2mo");
  });

  it("formats tracking span as years and months", () => {
    // 2 years and 3 months
    const earliestDate = NOW - (2 * 365 + 90) * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    // (2*365+90) = 820 days, 820/30.44 ~ 26.9 months, 26/12 = 2 years, 26%12 = 2 remaining
    expect(result!.trackingSpan).toMatch(/^2y/);
  });

  it("formats tracking span as years only when no remaining months", () => {
    // Use enough days that floor(days/30.44) gives exactly 24 months (2 years, 0 remaining)
    // 24 * 30.44 = 730.56, so 731 days => floor(731/30.44) = 24 months => 2y 0mo => "2y"
    const earliestDate = NOW - 731 * DAY_SECONDS;
    const result = computePegStability([], earliestDate, NOW);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("2y");
  });
});
