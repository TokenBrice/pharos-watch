import { describe, expect, it } from "vitest";
import type { DepegEvent } from "../../types/market";
import { computePegScore, PEG_SCORE_LOOKBACK_SEC, type PegScoreResult } from "../peg-score";
import * as formulaModule from "../safety-score-v9/formula";
import { DAY_SECONDS } from "../time-constants";

/**
 * STAGE A pin for owner ruling D3 (2026-07-17, provisional pending the V8
 * counterfactual-matrix review): band-aware peg scoring in the V9 shadow path.
 *
 *   Deviations inside a mechanism's documented redemption band (e.g. <=100bps
 *   for redemption-arbitrage CDPs) stop counting as peg events; band-breaks
 *   still count. MIM/EURS-shaped histories (active depegs far outside any
 *   band, no documented band) must NOT benefit.
 *
 * CRITICAL TRUST BOUNDARY: the public V8 peg computation
 * (`shared/lib/peg-score.ts`) must remain byte-identical — band awareness
 * exists only in the V9 adapter path. The ACTIVE block is that regression: it
 * pins full `computePegScore` outputs for fixed histories. The `describe.skip`
 * block pins the ruled band-aware semantics against the Stage B seam; it fails
 * today by construction and is enabled by Stage B.
 *
 * STAGE B SEAM (proposed contract; Stage B may place it in a new
 * `shared/lib/safety-score-v9/peg-band.ts` or the worker-side V9 adapter and
 * re-point this lookup — the semantics are the ruled part):
 *
 *   export function deriveV9BandAwarePegScore(
 *     events: DepegEvent[],
 *     band: { maxDeviationBps: number },  // 0 => no documented band (V8 semantics)
 *     trackingStartSec: number | null,
 *     nowSec?: number,
 *   ): PegScoreResult
 */

const deriveV9BandAwarePegScore = (formulaModule as unknown as Record<string, unknown>)
  .deriveV9BandAwarePegScore as
  | ((events: DepegEvent[], band: { maxDeviationBps: number }, trackingStartSec: number | null, nowSec?: number) => PegScoreResult)
  | undefined;

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

// STAGE B: un-skip once the V9 band-aware peg derivation exists (V9 adapter
// path only — never the public producer).
describe.skip("D3 ruled band-aware peg — pending Stage B implementation", () => {
  const NO_BAND = { maxDeviationBps: 0 };
  const BAND_100 = { maxDeviationBps: 100 };

  it("exposes the Stage B seam", () => {
    expect(typeof deriveV9BandAwarePegScore).toBe("function");
  });

  it("does not reduce the peg score for in-band-only deviation histories", () => {
    const result = deriveV9BandAwarePegScore!(IN_BAND, BAND_100, TRACKING_START, NOW);
    const baseline = computePegScore([], TRACKING_START, NOW);
    expect(result.pegScore).toBe(baseline.pegScore);
    expect(result.severityScore).toBe(baseline.severityScore);
  });

  it("still counts band-breaks against the peg score", () => {
    const bandAware = deriveV9BandAwarePegScore!(BAND_BREAK, BAND_100, TRACKING_START, NOW);
    const v8 = computePegScore(BAND_BREAK, TRACKING_START, NOW);
    expect(bandAware.pegScore).toBe(v8.pegScore);
  });

  it("counts only the band-breaks of a mixed history", () => {
    const mixed = deriveV9BandAwarePegScore!([...IN_BAND, ...BAND_BREAK], BAND_100, TRACKING_START, NOW);
    const breaksOnlyV8 = computePegScore(BAND_BREAK, TRACKING_START, NOW);
    expect(mixed.pegScore).toBe(breaksOnlyV8.pegScore);
    expect(mixed.eventCount).toBeLessThan(IN_BAND.length + BAND_BREAK.length);
  });

  it("treats a deviation at exactly the band edge as in-band and band+1 as a break", () => {
    const atEdge = deriveV9BandAwarePegScore!([event(-100, 40, 2)], BAND_100, TRACKING_START, NOW);
    const beyondEdge = deriveV9BandAwarePegScore!([event(-101, 40, 2)], BAND_100, TRACKING_START, NOW);
    expect(atEdge.pegScore).toBe(computePegScore([], TRACKING_START, NOW).pegScore);
    expect(beyondEdge.pegScore).toBe(computePegScore([event(-101, 40, 2)], TRACKING_START, NOW).pegScore);
  });

  it("is identical to V8 when no band is documented (MIM/EURS must not benefit)", () => {
    for (const history of [MIM_SHAPED, EURS_SHAPED, IN_BAND, BAND_BREAK]) {
      expect(deriveV9BandAwarePegScore!(history, NO_BAND, TRACKING_START, NOW)).toEqual(
        computePegScore(history, TRACKING_START, NOW),
      );
    }
  });

  it("never lowers the score when the documented band widens", () => {
    const narrow = deriveV9BandAwarePegScore!(IN_BAND, { maxDeviationBps: 50 }, TRACKING_START, NOW);
    const wide = deriveV9BandAwarePegScore!(IN_BAND, { maxDeviationBps: 100 }, TRACKING_START, NOW);
    expect(wide.pegScore!).toBeGreaterThanOrEqual(narrow.pegScore!);
  });
});
