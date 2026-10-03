import { describe, expect, it } from "vitest";
import type { DepegEvent } from "../../types/market";
import { computePegScore, PEG_SCORE_LOOKBACK_SEC } from "../peg-score";
import { DAY_SECONDS } from "../time-constants";
import { deriveV9WindowedPegScore } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

/** Public four-year peg history stays separate from the V9-only window proxy. */

const NOW = 1_800_000_000;
const TRACKING_START = NOW - PEG_SCORE_LOOKBACK_SEC;

function event(peakDeviationBps: number, startedDaysAgo: number, durationDays: number | null): DepegEvent {
  return {
    id: 1,
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


describe("public peg history and V9 window trust boundary", () => {
  it("retains a closed incident beyond the V9 window without leaking its quiet-history floor into public scoring", () => {
    const history = [event(-9000, Math.floor(3.5 * 365.25), 90)];
    const publicScore = computePegScore(history, TRACKING_START, NOW);
    const { pegHistoryWindowSec, pegQuietHistoryFloor } = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;
    const adapted = deriveV9WindowedPegScore({
      pegScore: publicScore.pegScore,
      activeDepeg: publicScore.activeDepeg,
      lastEventAt: publicScore.lastEventAt,
      clockSec: NOW,
      windowSec: pegHistoryWindowSec,
      quietHistoryFloor: pegQuietHistoryFloor,
    });
    expect(publicScore.scoredEventCount).toBe(1);
    expect(publicScore.pegScore).toBeLessThan(pegQuietHistoryFloor);
    expect(adapted).toBe(pegQuietHistoryFloor);
    expect(computePegScore(history, TRACKING_START, NOW).pegScore).toBe(publicScore.pegScore);
  });

  it.each([[-7800, 10], [-4100, 400]])("preserves a legacy-open %i bps incident without inventing %i days of trusted duration", (peak, days) => {
    const history = [event(peak, days, null)];
    const publicScore = computePegScore(history, TRACKING_START, NOW);
    expect(publicScore.activeDepeg).toBe(true);
    expect(publicScore.worstDeviationBps).toBe(peak);
    expect(publicScore.unknownCoverageSeconds).toBe(days * DAY_SECONDS);
    const onlyBlindHistory = computePegScore(history, history[0]!.startedAt, NOW);
    expect(onlyBlindHistory.pegPct).toBeNull();
    expect(onlyBlindHistory.pegScore).toBeNull();
    const later = computePegScore(history, history[0]!.startedAt, NOW + DAY_SECONDS);
    expect(later.pegPct).toBeNull();
    expect(later.unknownCoverageSeconds).toBe((days + 1) * DAY_SECONDS);
  });
});
