import { describe, it, expect } from "vitest";
import { computePegScore, computeRecentPegStats, coinTrackingStart, PEG_SCORE_LOOKBACK_SEC } from "../peg-score";

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
    const events = [
      {
        startedAt: NOW - DAY,
        endedAt: null,
        peakDeviationBps: 500,
        direction: "below" as const,
      },
    ];
    const result = computePegScore(events as never, start, NOW);
    expect(result.pegScore).toBeLessThan(100);
    expect(result.activeDepeg).toBe(true);
  });

  it("uses the magnitude floor for brief high-deviation events", () => {
    const start = NOW - 30 * DAY;
    const eventStart = NOW - DAY;
    const events = [
      {
        startedAt: eventStart,
        endedAt: eventStart + 2 * 60 * 60,
        peakDeviationBps: 400,
        direction: "below" as const,
      },
    ];

    const recencyWeight = 1 / (1 + (NOW - eventStart) / (365.25 * DAY));
    const durationPenalty = (400 / 100) * (2 / 24 / 30) * recencyWeight;
    const magnitudeFloor = (400 / 2000) * recencyWeight;

    expect(magnitudeFloor).toBeGreaterThan(durationPenalty);
    const result = computePegScore(events as never, start, NOW);
    expect(100 - result.severityScore).toBeCloseTo(magnitudeFloor, 6);
  });

  it("weights recent events more heavily than old ones", () => {
    const start = NOW - 365 * DAY;
    const recentEvent = [
      {
        startedAt: NOW - 30 * DAY,
        endedAt: NOW - 20 * DAY,
        peakDeviationBps: 5000,
        direction: "below" as const,
      },
    ];
    const oldEvent = [
      {
        startedAt: NOW - 350 * DAY,
        endedAt: NOW - 340 * DAY,
        peakDeviationBps: 5000,
        direction: "below" as const,
      },
    ];
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

  it("excludes false-positive and disputed events from PegScore inputs", () => {
    const start = NOW - 90 * DAY;
    const excludedEvents = [
      {
        startedAt: NOW - 30 * DAY,
        endedAt: NOW - 20 * DAY,
        peakDeviationBps: 5000,
        direction: "below" as const,
        provenance: { auditVerdict: "false_positive", confidenceTier: "low" },
      },
      {
        startedAt: NOW - 10 * DAY,
        endedAt: NOW - 9 * DAY,
        peakDeviationBps: 800,
        direction: "above" as const,
        provenance: { auditVerdict: "disputed", confidenceTier: "medium" },
      },
    ];
    const result = computePegScore(excludedEvents as never, start, NOW);
    expect(result.pegScore).toBe(100);
    expect(result.scoredEventCount).toBe(0);
    expect(result.excludedEventCount).toBe(2);
    expect(result.qualityAdjusted).toBe(true);
  });

  it("excludes incidents that ended before the tracking boundary from every score input", () => {
    const start = NOW - 90 * DAY;
    const observedEvent = {
      startedAt: NOW - 30 * DAY,
      endedAt: NOW - 29 * DAY,
      peakDeviationBps: 250,
      direction: "below" as const,
    };
    const preCoverageEvent = {
      startedAt: start - 30 * DAY,
      endedAt: start,
      peakDeviationBps: 10_000,
      direction: "below" as const,
    };

    expect(computePegScore([preCoverageEvent, observedEvent] as never, start, NOW)).toEqual(
      computePegScore([observedEvent] as never, start, NOW),
    );
  });

  it("downweights low-confidence events without dropping them", () => {
    const start = NOW - 180 * DAY;
    const event = {
      startedAt: NOW - 30 * DAY,
      endedAt: NOW - 20 * DAY,
      peakDeviationBps: 4000,
      direction: "below" as const,
    };
    const highConfidence = computePegScore([{ ...event, provenance: { confidenceTier: "high" } }] as never, start, NOW);
    const lowConfidence = computePegScore([{ ...event, provenance: { confidenceTier: "low" } }] as never, start, NOW);

    expect(lowConfidence.pegScore!).toBeGreaterThan(highConfidence.pegScore!);
    expect(lowConfidence.scoredEventCount).toBe(1);
    expect(lowConfidence.lowConfidenceEventCount).toBe(1);
    expect(lowConfidence.qualityAdjusted).toBe(true);
  });

  describe("spreadPenalty (severity-weighted stddev path)", () => {
    const start = NOW - 90 * DAY;

    function makeEvent(startOffset: number, bps: number, confidence?: "low" | "high") {
      return {
        startedAt: NOW - startOffset * DAY,
        endedAt: NOW - (startOffset - 1) * DAY,
        peakDeviationBps: bps,
        direction: "below" as const,
        ...(confidence ? { provenance: { confidenceTier: confidence } } : {}),
      };
    }

    it("returns spreadPenalty=0 with a single event (< 2 scored events)", () => {
      const result = computePegScore([makeEvent(30, 400)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(0);
    });

    it("returns spreadPenalty=0 when two events have equal |bps| (zero stddev)", () => {
      const result = computePegScore([makeEvent(40, 300), makeEvent(20, 300)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(0);
    });

    it("returns spreadPenalty>0 when two events have differing |bps|", () => {
      const result = computePegScore([makeEvent(60, 100), makeEvent(30, 900)] as never, start, NOW);
      expect(result.spreadPenalty).toBeGreaterThan(0);
      expect(result.spreadPenalty).toBeLessThanOrEqual(15);
    });

    it("low-confidence half-weight changes spreadPenalty vs high-confidence same bps", () => {
      const eventsHigh = [
        { ...makeEvent(60, 200), provenance: { confidenceTier: "high" } },
        { ...makeEvent(30, 800), provenance: { confidenceTier: "high" } },
      ];
      const eventsLow = [
        { ...makeEvent(60, 200), provenance: { confidenceTier: "low" } },
        { ...makeEvent(30, 800), provenance: { confidenceTier: "high" } },
      ];
      const high = computePegScore(eventsHigh as never, start, NOW);
      const low = computePegScore(eventsLow as never, start, NOW);
      // Low-confidence weight=0.5 on first event shifts the weighted mean
      // and reduces the effective stddev compared to both at full weight.
      expect(high.spreadPenalty).not.toBe(low.spreadPenalty);
    });

    it("caps spreadPenalty at 15 for extreme variance", () => {
      const result = computePegScore([makeEvent(80, 1), makeEvent(40, 100_000)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(15);
    });
  });
});

describe("computeRecentPegStats", () => {
  it("uses only observed coverage and exposes grouped threshold crossings", () => {
    const coverageStart = NOW - 20 * DAY;
    const result = computeRecentPegStats(
      [
        {
          startedAt: NOW - 10 * DAY,
          endedAt: NOW - 8 * DAY,
          peakDeviationBps: -220,
          constituentEventCount: 4,
          direction: "below" as const,
        },
      ] as never,
      coverageStart,
      NOW,
    );

    expect(result).toMatchObject({
      windowDays: 90,
      observedDays: 20,
      coverageLimited: true,
      pegPct: 90,
      incidentCount: 1,
      thresholdCrossingCount: 4,
      worstDeviationBps: -220,
    });
  });

  it("excludes audited false positives from the recent window", () => {
    const result = computeRecentPegStats(
      [
        {
          startedAt: NOW - 5 * DAY,
          endedAt: NOW - 4 * DAY,
          peakDeviationBps: -500,
          direction: "below" as const,
          provenance: { auditVerdict: "false_positive" },
        },
      ] as never,
      NOW - 90 * DAY,
      NOW,
    );

    expect(result).toMatchObject({ pegPct: 100, incidentCount: 0, thresholdCrossingCount: 0 });
  });
});
