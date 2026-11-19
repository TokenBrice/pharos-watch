import { describe, it, expect } from "vitest";
import { makePegEvent as makeEvent } from "@shared/test-utils/peg-fixtures";
import { DepegEventSchema } from "@shared/types/peg";
import type { PegScoreEvent } from "../peg-utils";
import {
  computePegScore,
  computeRecentPegStats,
  coinTrackingStart,
  PEG_SCORE_LOOKBACK_SEC,
} from "../peg-score";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const sec = (iso: string) => Date.parse(iso) / 1000;

describe("scheduled reference coverage", () => {
  it("counts 30 hours of legacy severe weekend observations while excluding blind closure time", () => {
    const start = sec("2026-11-21T00:00:00Z");
    const now = start + 30 * 3600;
    const from = now - 90 * DAY;
    const event = makeEvent({
      pegType: "peggedEUR", startedAt: start - 900, endedAt: null, peakDeviationBps: -3000,
      priceCoverage: { intervals: [[start, now]], lastTrustedObservationAt: now, gapStartedAt: null, lastObservationKind: "trusted-off-peg" },
    });
    const quiet = computeRecentPegStats([], from, now, "EUR")!;
    const result = computeRecentPegStats([event], from, now, "EUR")!;
    expect(result.observedDays).toBeCloseTo(quiet.observedDays + 1.25);
    expect(result.pegPct).toBeCloseTo(100 * (1 - 1.25 / (quiet.observedDays + 1.25)), 5);
  });

  it("penalizes a fresh severe weekend observation with a legacy ledger omission", () => {
    const now = sec("2026-11-14T12:00:00Z");
    const startedAt = now - 900;
    const event = makeEvent({
      stablecoinId: "eurc-circle", pegType: "peggedEUR", startedAt, endedAt: null, peakDeviationBps: -3000,
      confirmationSources: "primary:coingecko+primary:market:kraken",
      priceCoverage: { intervals: [[startedAt, now]], lastTrustedObservationAt: now, gapStartedAt: null, lastObservationKind: "trusted-off-peg" },
    });
    const from = now - 180 * DAY;
    expect(computePegScore([event], from, now, "EUR")).toMatchObject({ pegScore: 49, activeDepeg: true });
    expect(computePegScore([{ ...event, admittedCoverage: [] }], from, now, "EUR").pegScore).toBe(100);
    expect(computePegScore([{ ...event, peakDeviationBps: -2400 }], from, now, "EUR").pegScore).toBe(100);
    expect(computePegScore([event], from, now + 1201, "EUR").pegScore).toBe(99);
  });

  it("preserves blind time for uncovered events while excluding reviewed artifacts", () => {
    const from = NOW - 20 * DAY;
    const event = makeEvent({ startedAt: NOW - 10 * DAY, endedAt: NOW - 5 * DAY, peakDeviationBps: -180, admittedCoverage: [] });
    const quiet = computeRecentPegStats([], from, NOW)!;
    expect(computeRecentPegStats([event], from, NOW)?.observedDays).toBe(quiet.observedDays - 5);
    expect(computeRecentPegStats([{ ...event, disposition: "repaired" }], from, NOW)?.observedDays).toBe(quiet.observedDays);
    expect(computePegScore([{ ...event, admittedCoverage: [{ fromSec: event.startedAt, toSec: event.endedAt! }],
      provenance: { pegScoreEligible: false } }], from, NOW)).toMatchObject({ pegPct: 100, excludedEventCount: 1 });
  });

  it.each([
    ["explicitly admitted at close", 0, true, -1500, 1],
    ["legacy at close", 0, false, -1500, 0],
    ["legacy before close", -1, false, -1500, 1],
    ["severe legacy opening at close", 0, false, -2500, 1],
  ] as const)("counts a point separately from elapsed off-peg time (%s)", (_label, offset, explicit, peakDeviationBps, count) => {
    const now = sec("2026-11-13T22:00:00Z") + offset;
    const from = now - 90 * DAY;
    const event = DepegEventSchema.parse(makeEvent({
      pegType: "peggedGOLD", startedAt: now, peakDeviationBps,
      ...(explicit ? { admittedCoverage: [{ fromSec: now, toSec: now + 1 }] }
        : { priceCoverage: { intervals: [[now, now]], lastTrustedObservationAt: now, gapStartedAt: null } }),
    }));
    const quiet = computeRecentPegStats([], from, now, "GOLD")!;
    expect(computeRecentPegStats([event], from, now, "GOLD")).toMatchObject({
      incidentCount: count, thresholdCrossingCount: count, worstDeviationBps: count ? peakDeviationBps : null,
      pegPct: 100, observedDays: quiet.observedDays,
    });
    expect(computePegScore([event], from, now, "GOLD").activeDepeg).toBe(count > 0);
    if (!count) expect(computeRecentPegStats([event], from, now + 1, "GOLD")?.incidentCount).toBe(0);
  });

  it.each([false, true])("counts only admitted off-peg time on a retained closure-origin event (explicit: %s)", (explicit) => {
    const start = sec("2025-03-30T00:00:00Z");
    const reopen = sec("2025-03-30T21:00:00Z");
    const end = sec("2025-04-01T00:00:00Z");
    const event = makeEvent({
      pegType: "peggedTRY", startedAt: start, endedAt: end, peakDeviationBps: -300,
      ...(explicit ? { admittedCoverage: [{ fromSec: reopen + DAY, toSec: end }] } : {}),
    });
    const now = end + DAY;
    const from = now - 90 * DAY;
    const result = computeRecentPegStats([event], from, now, "TRY")!;
    const quiet = computeRecentPegStats([], from, now, "TRY")!;
    expect(quiet).toMatchObject({ coverageLimited: true, pegPct: 100, incidentCount: 0 });
    expect(quiet.observedDays).toBeLessThan(66);
    const offPegDays = (end - reopen) / DAY - (explicit ? 1 : 0);
    expect(result).toMatchObject({ coverageLimited: true, incidentCount: 1 });
    expect(result.pegPct).toBeCloseTo(100 * (1 - offPegDays / result.observedDays), 2);
    expect(computeRecentPegStats([{ ...event, admittedCoverage: [] }], from, now, "TRY"))
      .toMatchObject({ incidentCount: 0, worstDeviationBps: null, pegPct: 100 });
    expect(computePegScore([event], from, now, "TRY"))
      .toMatchObject({ lastEventAt: start, lastAffectedAtSec: end });
  });

  it.each(["2026-11-14T13:00:00Z", "2026-11-16T01:00:00Z"])("retains only detector-declared hold evidence at %s", (time) => {
    const start = sec("2026-11-14T12:00:00Z");
    const lastTrustedAtSec = start + 60;
    const declaredAtSec = start + 120;
    const event: PegScoreEvent = {
      ...makeEvent({ pegType: "peggedGOLD", startedAt: start, endedAt: null, peakDeviationBps: -500 }),
      admittedCoverage: [{ fromSec: start, toSec: lastTrustedAtSec + 1 }],
      priceCoverage: { intervals: [[start, lastTrustedAtSec + 1]], lastTrustedObservationAt: lastTrustedAtSec,
        gapStartedAt: declaredAtSec, lastObservationKind: "blind" },
      referenceHold: { reason: "reference-market-closed", declaredAtSec, refreshedAtSec: sec(time) - 1200, lastTrustedAtSec, lastTrustedPeakBps: -500 },
    };
    const from = start - 90 * DAY;
    const held = computePegScore([event], from, sec(time), "GOLD");
    const generic = computePegScore([{ ...event, referenceHold: undefined } as PegScoreEvent], from, sec(time), "GOLD");
    const exactEnd: PegScoreEvent = { ...event, admittedCoverage: [{ fromSec: start, toSec: lastTrustedAtSec }] };
    const boundary = computePegScore([exactEnd], from, sec(time), "GOLD");
    expect(generic.pegScore! - held.pegScore!).toBe(10);
    expect(boundary.pegScore).toBe(generic.pegScore);
    const expiredHold: PegScoreEvent = { ...event, referenceHold: { ...event.referenceHold!, refreshedAtSec: sec(time) - 1201 } };
    expect(computePegScore([expiredHold], from, sec(time), "GOLD").pegScore).toBe(generic.pegScore);
    expect(held.unknownCoverageSeconds).toBe(generic.unknownCoverageSeconds);
    expect(held.lastAffectedAtSec).toBe(lastTrustedAtSec + 1);
  });

  it.each([false, true])("masks archived PAXG 91049 off-peg and at-par intervals unless admitted (%s)", (admitted) => {
    const start = 1_794_690_066;
    const end = 1_794_769_321;
    const [fromSec, toSec] = [1_794_729_743, 1_794_767_488];
    const event = makeEvent({ id: 91049, pegType: "peggedGOLD", startedAt: start, endedAt: end, peakDeviationBps: -156,
      priceCoverage: { intervals: [[fromSec, toSec]], atParIntervals: [[1_794_768_404, end]],
        lastTrustedObservationAt: end, gapStartedAt: 1_794_768_404 },
      ...(admitted ? { admittedCoverage: [{ fromSec, toSec }] } : {}),
    });
    const from = start - 60 * DAY;
    const now = sec("2026-11-16T12:00:00Z");
    const quiet = computeRecentPegStats([], from, now, "GOLD")!;
    const result = computeRecentPegStats([event], from, now, "GOLD")!;
    expect(result).toMatchObject({ incidentCount: admitted ? 1 : 0, worstDeviationBps: admitted ? -156 : null });
    expect((result.observedDays - quiet.observedDays) * DAY).toBeCloseTo(admitted ? 37_745 : 0);
  });

  it("records a chronology bound for USDB 90799 alongside an older dated incident", () => {
    const clock = 1_795_000_000;
    const olderEnd = clock - 1_200 * DAY;
    const events = [
      makeEvent({ startedAt: olderEnd - DAY, endedAt: olderEnd, peakDeviationBps: -9000 }),
      makeEvent({ id: 90799, startedAt: 1_791_009_048, endedAt: 1_791_295_299, peakDeviationBps: -129,
        priceCoverage: { intervals: [], lastTrustedObservationAt: null, gapStartedAt: 1_791_040_635 },
      }),
    ];
    expect(computePegScore(events, clock - PEG_SCORE_LOOKBACK_SEC, clock, "USD")).toMatchObject({
      eventCount: 2, lastAffectedAtSec: olderEnd, lastUncertainAffectedAtSec: 1_791_295_299,
    });
  });

  it.each([false, true])("keeps confirmed VCHF 90796 through closure with legacy duration unknown (closed: %s)", (closed) => {
    const start = 1_790_658_132;
    const end = 1_792_477_916;
    const event = makeEvent({ id: 90796, stablecoinId: "vchf-vnx", pegType: "peggedCHF", startedAt: start,
      endedAt: closed ? end : null, peakDeviationBps: 740, confirmationSources: "temporal:15m+native:chf",
      priceCoverage: { intervals: [], atParIntervals: [], lastObservationKind: "blind",
        lastTrustedObservationAt: null, gapStartedAt: 1_791_040_635 },
    });
    const from = end - 90 * DAY;
    const score = computePegScore([event], from, end, "CHF");
    expect(score).toMatchObject({ eventCount: 1, worstDeviationBps: 740, activeDepeg: !closed,
      pegPct: 100, lastAffectedAtSec: null });
    expect(score.lastUncertainAffectedAtSec).toBe(closed ? end : undefined);
    expect(computeRecentPegStats([event], from, end, "CHF")).toMatchObject({
      incidentCount: 1, worstDeviationBps: 740, coverageLimited: true, pegPct: 100,
    });
    expect(computePegScore([{ ...event, admittedCoverage: [] }], from, end, "CHF")).toMatchObject({
      eventCount: 0, worstDeviationBps: null, activeDepeg: false,
    });
  });
});

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

  it("uses the earliest event when firstSeen is unavailable", () => {
    const events = [
      makeEvent({ startedAt: NOW - 100 * DAY, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 50 * DAY, peakDeviationBps: -200 }),
    ];
    expect(coinTrackingStart(events as never, fourYearsAgo)).toBe(NOW - 100 * DAY);
  });

  it("prefers firstSeen over the earliest event when it is older", () => {
    const firstSeen = NOW - 300 * DAY;
    const events = [makeEvent({ startedAt: NOW - 100 * DAY, peakDeviationBps: -200 })];
    expect(coinTrackingStart(events as never, fourYearsAgo, firstSeen)).toBe(firstSeen);
  });
});

describe("computePegScore", () => {
  it("becomes eligible at exactly seven days, not one second earlier", () => {
    expect(computePegScore([], NOW - 7 * DAY + 1, NOW).pegScore).toBeNull();
    expect(computePegScore([], NOW - 7 * DAY, NOW).pegScore).toBe(100);
  });

  it("returns null pegScore with stable defaults when no tracking start exists", () => {
    const result = computePegScore([], coinTrackingStart([], NOW - PEG_SCORE_LOOKBACK_SEC), NOW);

    expect(result).toMatchObject({
      pegScore: null,
      pegPct: null,
      severityScore: 100,
      spreadPenalty: 0,
      eventCount: 0,
      worstDeviationBps: null,
      activeDepeg: false,
      lastEventAt: null,
      trackingSpanDays: 0,
    });
  });

  it("returns 100 for a coin with no depeg events over 30+ days", () => {
    const start = NOW - 60 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBe(100);
    expect(result.pegPct).toBeCloseTo(100);
    expect(result.severityScore).toBeCloseTo(100);
  });

  it("scores the explicit four-year window while preserving a younger first-seen anchor", () => {
    const events = [makeEvent({ startedAt: NOW - 10 * DAY, endedAt: NOW - 9 * DAY, peakDeviationBps: -200 })];
    for (const [firstSeen, trackingSpanDays] of [[NOW - 120 * DAY, 120], [NOW - 10 * 365 * DAY, 1461]]) {
      const start = coinTrackingStart(events, NOW - PEG_SCORE_LOOKBACK_SEC, firstSeen);
      expect(computePegScore(events, start, NOW)).toMatchObject({
        eventCount: 1,
        trackingSpanDays,
        worstDeviationBps: -200,
      });
    }
  });

  it("penalizes active depeg events", () => {
    const start = NOW - 90 * DAY;
    const events = [{
      ...makeEvent({ startedAt: NOW - DAY, endedAt: null, peakDeviationBps: 500 }),
      priceCoverage: { intervals: [[NOW - DAY, NOW]], lastTrustedObservationAt: NOW, gapStartedAt: null },
    }];
    const result = computePegScore(events as never, start, NOW);
    expect(result.pegScore).toBeLessThan(100);
    expect(result.activeDepeg).toBe(true);
  });

  it("uses the magnitude floor for brief high-deviation events", () => {
    const start = NOW - 30 * DAY;
    const eventStart = NOW - DAY;
    const events = [makeEvent({
      startedAt: eventStart,
      endedAt: eventStart + 2 * 60 * 60,
      peakDeviationBps: 400,
    })];

    const recencyWeight = 1 / (1 + (NOW - eventStart) / (365.25 * DAY));
    const durationPenalty = (400 / 100) * (2 / 24 / 30) * recencyWeight;
    const magnitudeFloor = (400 / 2000) * recencyWeight;

    expect(magnitudeFloor).toBeGreaterThan(durationPenalty);
    const result = computePegScore(events as never, start, NOW);
    expect(100 - result.severityScore).toBeCloseTo(magnitudeFloor, 6);
  });

  it("weights recent events more heavily than old ones", () => {
    const start = NOW - 365 * DAY;
    const recentEvent = [makeEvent({ startedAt: NOW - 30 * DAY, endedAt: NOW - 20 * DAY, peakDeviationBps: 5000 })];
    const oldEvent = [makeEvent({ startedAt: NOW - 350 * DAY, endedAt: NOW - 340 * DAY, peakDeviationBps: 5000 })];
    const recentResult = computePegScore(recentEvent as never, start, NOW);
    const oldResult = computePegScore(oldEvent as never, start, NOW);
    expect(recentResult.pegScore!).toBeLessThan(oldResult.pegScore!);
  });

  it("handles NaN peakDeviationBps without producing NaN score", () => {
    const start = NOW - 90 * DAY;
    const events = [
      makeEvent({ startedAt: NOW - 30 * DAY, endedAt: NOW - 29 * DAY, peakDeviationBps: NaN }),
      makeEvent({ startedAt: NOW - 20 * DAY, endedAt: NOW - 19 * DAY, peakDeviationBps: 200 }),
    ];
    const result = computePegScore(events as never, start, NOW);
    expect(Number.isFinite(result.pegScore)).toBe(true);
    expect(result.pegScore).toBe(computePegScore(
      events.map((event) => ({ ...event, peakDeviationBps: Number.isNaN(event.peakDeviationBps) ? 0 : event.peakDeviationBps })) as never,
      start,
      NOW,
    ).pegScore);
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

    function eventAtOffset(startOffset: number, bps: number) {
      return makeEvent({
        startedAt: NOW - startOffset * DAY,
        endedAt: NOW - (startOffset - 1) * DAY,
        peakDeviationBps: bps,
      });
    }

    it("returns spreadPenalty=0 with a single below-peg event", () => {
      const result = computePegScore([eventAtOffset(30, -400)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(0);
    });

    it("returns spreadPenalty=0 when two events have equal |bps| (zero stddev)", () => {
      const result = computePegScore([eventAtOffset(40, -300), eventAtOffset(20, -300)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(0);
    });

    it("returns spreadPenalty>0 when two events have differing |bps|", () => {
      const result = computePegScore([eventAtOffset(60, -100), eventAtOffset(30, -900)] as never, start, NOW);
      expect(result.spreadPenalty).toBeGreaterThan(0);
      expect(result.spreadPenalty).toBeLessThanOrEqual(15);
    });

    it("confidence-weights the spread mean/variance so a downgrade lowers the penalty", () => {
      const eventsHigh = [
        { ...eventAtOffset(60, -200), provenance: { confidenceTier: "high" } },
        { ...eventAtOffset(30, -800), provenance: { confidenceTier: "high" } },
      ];
      const eventsLow = [
        { ...eventAtOffset(60, -200), provenance: { confidenceTier: "low" } },
        { ...eventAtOffset(30, -800), provenance: { confidenceTier: "high" } },
      ];
      const high = computePegScore(eventsHigh as never, start, NOW);
      const low = computePegScore(eventsLow as never, start, NOW);
      // Weights 1 and 1: mean 500, variance 90,000. Weights 0.5 and 1:
      // mean 600, variance 80,000 — the weight sum divides both moments.
      expect(high.spreadPenalty).toBeCloseTo(4.5, 10);
      expect(low.spreadPenalty).toBeCloseTo((Math.sqrt(80_000) / 1000) * 15, 10);
      expect(low.spreadPenalty).toBeLessThan(high.spreadPenalty);
    });

    it("does not invent dispersion between identical peaks when one row is low confidence", () => {
      const events = [
        { ...eventAtOffset(60, -800), provenance: { confidenceTier: "low" } },
        { ...eventAtOffset(30, -800), provenance: { confidenceTier: "high" } },
      ];
      // The same -800 bps peak observed twice carries no spread, whatever the
      // evidence weight; halving the magnitude would fabricate a 200 bps gap.
      expect(computePegScore(events as never, start, NOW).spreadPenalty).toBe(0);
    });

    it("caps spreadPenalty at 15 for extreme variance", () => {
      const result = computePegScore([eventAtOffset(80, -1), eventAtOffset(40, -100_000)] as never, start, NOW);
      expect(result.spreadPenalty).toBe(15);
    });

    it("excludes an above-peg spike without diluting the below-peg spread", () => {
      const belowPeg = [eventAtOffset(60, -100), eventAtOffset(30, -900)];
      const baseline = computePegScore(belowPeg as never, start, NOW);
      const result = computePegScore([...belowPeg, eventAtOffset(10, 6544)] as never, start, NOW);

      expect(baseline.spreadPenalty).toBeCloseTo(6);
      expect(result.spreadPenalty).toBe(baseline.spreadPenalty);
      // Above-peg events still enter the time, severity and diagnostic inputs.
      expect(result.pegPct!).toBeLessThan(baseline.pegPct!);
      expect(result.severityScore).toBeLessThan(baseline.severityScore);
      expect(result.scoredEventCount).toBe(3);
      expect(result.worstDeviationBps).toBe(6544);
    });

    it("keeps the maximum spread penalty for a below-peg spike", () => {
      const result = computePegScore([
        eventAtOffset(60, -100),
        eventAtOffset(30, -900),
        eventAtOffset(10, -6544),
      ] as never, start, NOW);

      expect(result.spreadPenalty).toBe(15);
    });

    it("does not treat a symmetric above/below pair as two downside observations", () => {
      const result = computePegScore([
        eventAtOffset(60, -6544),
        eventAtOffset(30, 6544),
      ] as never, start, NOW);

      expect(result.spreadPenalty).toBe(0);
      expect(result.scoredEventCount).toBe(2);
      expect(result.severityScore).toBeLessThan(100);
    });

    it("assigns no spread penalty to an above-peg-only history", () => {
      const result = computePegScore([
        eventAtOffset(60, 100),
        eventAtOffset(30, 6544),
      ] as never, start, NOW);

      expect(result.spreadPenalty).toBe(0);
    });
  });
});

describe("active depeg penalty thresholds", () => {
  const now = 1_700_000_000;
  const trackingStart = now - 365 * DAY;
  // One day out of 365 reduces the time component by 0.137 points;
  // the severity magnitude floors contribute 0.025, 0.125 and 1.247.
  const cases = [
    { name: "uses the 5-point floor at 100 bps", peakDeviationBps: -100, expected: 95 },
    { name: "scales a 500 bps depeg to 10 points", peakDeviationBps: -500, expected: 90 },
    { name: "caps a 5000 bps depeg at 50 points", peakDeviationBps: -5000, expected: 49 },
  ];

  it.each(cases)("$name", ({ peakDeviationBps, expected }) => {
    const result = computePegScore(
      [{
        ...makeEvent({ startedAt: now - DAY, peakDeviationBps }),
        priceCoverage: { intervals: [[now - DAY, now]], lastTrustedObservationAt: now, gapStartedAt: null },
      }] as never,
      trackingStart,
      now,
    );

    expect(result.pegScore).toBe(expected);
  });

  it("uses the worst concurrent active penalty rather than summing penalties", () => {
    const result = computePegScore([
      ...[-100, -500].map((peakDeviationBps) => ({
        ...makeEvent({ startedAt: now - DAY, peakDeviationBps }),
        priceCoverage: { intervals: [[now - DAY, now]], lastTrustedObservationAt: now, gapStartedAt: null },
      })),
    ] as never, trackingStart, now);
    // 49.863 time half + 49.850 severity half - 10 active - 3 spread = 86.713.
    expect(result.pegScore).toBe(87);
  });
});

describe("young coin with chronic depegs", () => {
  const now = 1_700_000_000;
  const coinAge = 30 * DAY;
  const trackingStart = now - coinAge;
  const events = Array.from({ length: 120 }, (_, i) =>
    makeEvent({
      startedAt: trackingStart + i * 6 * 3600,
      endedAt: trackingStart + i * 6 * 3600 + 2 * 3600,
      peakDeviationBps: -350,
    }),
  );

  it("scores chronic depegs against the coin's actual age", () => {
    const result = computePegScore(events as never, trackingStart, now);

    expect(result.pegScore).not.toBeNull();
    expect(result.pegScore!).toBeLessThan(80);
  });

  it("does not dilute a young coin's chronic depegs across four years", () => {
    const correctResult = computePegScore(events as never, trackingStart, now);
    const dilutedResult = computePegScore(events as never, now - 4 * 365.25 * DAY, now);

    expect(dilutedResult.pegScore!).toBeGreaterThan(correctResult.pegScore! + 15);
  });
});

describe("computeRecentPegStats", () => {
  it("requires a past tracking anchor", () => {
    for (const anchor of [null, NOW, NOW + DAY]) {
      expect(computeRecentPegStats([], anchor, NOW)).toBeNull();
    }
  });

  it("excludes boundary-ended incidents but clips straddling time to the recent window", () => {
    const boundary = NOW - 90 * DAY;
    const ended = makeEvent({ startedAt: boundary - DAY, endedAt: boundary, peakDeviationBps: -9000 });
    const straddling = makeEvent({ startedAt: boundary - DAY, endedAt: boundary + DAY, peakDeviationBps: -200 });
    const result = computeRecentPegStats([ended, straddling] as never, boundary - 30 * DAY, NOW);
    expect(result).toMatchObject({ observedDays: 90, coverageLimited: false, incidentCount: 1, thresholdCrossingCount: 1, worstDeviationBps: -200 });
    expect(result!.pegPct).toBeCloseTo(98.8888888889);
  });

  it("keeps an old unresolved event out of the recent census when its only admitted hour predates it", () => {
    const start = NOW - 180 * DAY;
    const event = makeEvent({ startedAt: start, peakDeviationBps: -500, constituentEventCount: 2,
      admittedCoverage: [{ fromSec: start, toSec: start + 3600 }],
    });
    expect(computeRecentPegStats([event], start, NOW)).toMatchObject({ observedDays: 0, coverageLimited: true,
      pegPct: null, incidentCount: 0, thresholdCrossingCount: 0, worstDeviationBps: null });
    expect(computePegScore([event], start, NOW)).toMatchObject({ eventCount: 1, activeDepeg: true, worstDeviationBps: -500 });
  });

  it("ignores future-start incidents in both score and recent summaries", () => {
    const event = makeEvent({ startedAt: NOW + 1, peakDeviationBps: -9000 });
    expect(computeRecentPegStats([event] as never, NOW - 90 * DAY, NOW)).toEqual(
      computeRecentPegStats([], NOW - 90 * DAY, NOW),
    );
    expect(computePegScore([event] as never, NOW - 90 * DAY, NOW)).toEqual(
      computePegScore([], NOW - 90 * DAY, NOW),
    );
  });

  it("counts one crossing for absent or zero constituent counts", () => {
    const event = makeEvent({ startedAt: NOW - DAY, endedAt: NOW, peakDeviationBps: -200 });
    const result = computeRecentPegStats([event, { ...event, constituentEventCount: 0 }] as never, NOW - 90 * DAY, NOW);
    expect(result).toMatchObject({ incidentCount: 2, thresholdCrossingCount: 2 });
  });

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

// A provider-skewed price observation is clamped to getFirstSeenDates' own
// clock (worker/src/lib/db.ts), which can be later than peg-analytics' scoring
// clock; curated pegScoreCoverage.startDate has no future bound. A non-positive
// raw span proves no observed at-peg second, so it must never publish 100%.
describe("computePegScore when the tracking anchor is at or after the scoring clock", () => {
  const openDepeg = () => makeEvent({ startedAt: NOW - DAY, endedAt: null, peakDeviationBps: -9000 });

  it.each([NOW, NOW + 30 * DAY])("does not invent at-peg occupancy for anchor %i", (anchor) => {
    expect(computePegScore([openDepeg()], anchor, NOW)).toMatchObject({
      pegScore: null,
      pegPct: null,
      eventCount: 1,
      activeDepeg: true,
      trackingSpanDays: 0,
    });
  });

  it("publishes no occupancy for an empty history when the anchor equals the clock", () => {
    expect(computePegScore([], NOW, NOW).pegPct).toBeNull();
  });

  it("agrees with the recent companion that the same anchor is unobserved", () => {
    for (const anchor of [NOW, NOW + 30 * DAY]) {
      expect(computeRecentPegStats([openDepeg()], anchor, NOW)).toBeNull();
    }
  });
});
