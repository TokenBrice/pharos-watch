import { describe, expect, it } from "vitest";
import type { DepegEvent } from "../../types/market";
import { computePegScore, PEG_SCORE_LOOKBACK_SEC } from "../peg-score";
import { DAY_SECONDS } from "../time-constants";

/**
 * D7 (2026-07-17) dropped the provisional D3 band-aware peg ruling. These
 * tests retain only the critical trust-boundary regression: the public V8 peg
 * computation and its adverse MIM/EURS outputs remain byte-identical.
 *
 * CRITICAL TRUST BOUNDARY: the public V8 peg computation
 * (`shared/lib/peg-score.ts`) must remain byte-identical — band awareness
 * exists only in the V9 adapter path. The ACTIVE block is that regression: it
 * pins full `computePegScore` outputs for fixed histories. Band-aware behavior
 * is intentionally absent from the V9 engine under D7.
 */

const NOW = 1_800_000_000;
const TRACKING_START = NOW - Math.ceil(2 * 365.25 * DAY_SECONDS); // 1736884800

let nextId = 1;
function event(peakDeviationBps: number, startedDaysAgo: number, durationDays: number | null): DepegEvent {
  return {
    id: nextId++,
    stablecoinId: "fixture-coin",
    symbol: "FIX",
    pegType: "USD",
    direction: peakDeviationBps < 0 ? "below" : "above",
    peakDeviationBps,
    startedAt: NOW - startedDaysAgo * DAY_SECONDS,
    endedAt: durationDays === null ? null : NOW - (startedDaysAgo - durationDays) * DAY_SECONDS,
    startPrice: 1,
    peakPrice: 1 + peakDeviationBps / 10_000,
    recoveryPrice: durationDays === null ? null : 1,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
  };
}

/** LUSD-shaped: short deviations inside a 100bps redemption band. */
const IN_BAND: DepegEvent[] = [event(-62, 40, 2), event(-85, 200, 3), event(95, 500, 3)];
/** Band-breaks: peaks far outside any documented band. */
const BAND_BREAK: DepegEvent[] = [event(-320, 30, 2), event(780, 100, 4)];
/** MIM-shaped: active deep depeg, no documented band. */
const MIM_SHAPED: DepegEvent[] = [event(-7800, 10, null)];
/** EURS-shaped: persistent ~41% deviation, no documented band. */
const EURS_SHAPED: DepegEvent[] = [event(-4100, 400, null)];

describe("D3 trust boundary — V8 public peg output is byte-identical (active regression)", () => {
  it("keeps the public 4-year lookback constant", () => {
    expect(PEG_SCORE_LOOKBACK_SEC).toBe(Math.ceil(4 * 365.25 * DAY_SECONDS));
  });

  it("reproduces the exact V8 result for an in-band-shaped history", () => {
    expect(computePegScore(IN_BAND, TRACKING_START, NOW)).toEqual({
      pegScore: 99,
      pegPct: 98.90485968514716,
      severityScore: 99.8677190692657,
      spreadPenalty: 0.20724381776062706,
      eventCount: 3,
      scoredEventCount: 3,
      excludedEventCount: 0,
      lowConfidenceEventCount: 0,
      qualityAdjusted: false,
      worstDeviationBps: 95,
      activeDepeg: false,
      lastEventAt: 1796544000,
      trackingSpanDays: 730,
    });
  });

  it("reproduces the exact V8 result for a band-break history", () => {
    expect(computePegScore(BAND_BREAK, TRACKING_START, NOW)).toEqual({
      pegScore: 96,
      pegPct: 99.17864476386036,
      severityScore: 98.98639468350825,
      spreadPenalty: 3.45,
      eventCount: 2,
      scoredEventCount: 2,
      excludedEventCount: 0,
      lowConfidenceEventCount: 0,
      qualityAdjusted: false,
      worstDeviationBps: 780,
      activeDepeg: false,
      lastEventAt: 1797408000,
      trackingSpanDays: 730,
    });
  });

  it("reproduces the exact V8 result for a MIM-shaped active depeg", () => {
    expect(computePegScore(MIM_SHAPED, TRACKING_START, NOW)).toEqual({
      pegScore: 37,
      pegPct: 98.63107460643394,
      severityScore: 74.69287141905397,
      spreadPenalty: 0,
      eventCount: 1,
      scoredEventCount: 1,
      excludedEventCount: 0,
      lowConfidenceEventCount: 0,
      qualityAdjusted: false,
      worstDeviationBps: -7800,
      activeDepeg: true,
      lastEventAt: 1799136000,
      trackingSpanDays: 730,
    });
  });

  it("reproduces the exact V8 result for an EURS-shaped persistent deviation", () => {
    expect(computePegScore(EURS_SHAPED, TRACKING_START, NOW)).toEqual({
      pegScore: 0,
      pegPct: 45.242984257357975,
      severityScore: 41.29271479908527,
      spreadPenalty: 0,
      eventCount: 1,
      scoredEventCount: 1,
      excludedEventCount: 0,
      lowConfidenceEventCount: 0,
      qualityAdjusted: false,
      worstDeviationBps: -4100,
      activeDepeg: true,
      lastEventAt: 1765440000,
      trackingSpanDays: 730,
    });
  });
});
