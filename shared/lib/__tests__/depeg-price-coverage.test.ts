import { describe, expect, it } from "vitest";
import type { DepegEvent, DepegPriceCoverage } from "../../types/market";
import { advanceDepegPriceCoverage } from "../depeg-price-coverage";
import { computePegScore } from "../peg-score";
import { hasCurrentTrustedDepegObservation, mergeDepegSeconds, mergeUnknownDepegSeconds } from "../peg-utils";

function openEvent(priceCoverage: DepegPriceCoverage): DepegEvent {
  return {
    id: 1, stablecoinId: "usda-avalon", symbol: "USDA", pegType: "peggedUSD",
    direction: "below", peakDeviationBps: -2000, startedAt: 0, endedAt: null,
    startPrice: 0.8, peakPrice: 0.8, recoveryPrice: null, pegReference: 1,
    source: "live", confirmationSources: null, pendingReason: null,
    closeReason: null, provenance: null, priceCoverage,
  };
}

describe("three-state trusted price coverage", () => {
  it("counts confirmed at-par time as known without bridging the state boundary or a blind run", () => {
    let coverage = advanceDepegPriceCoverage(null, 0, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, 600, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, 900, "trusted-at-par");
    coverage = advanceDepegPriceCoverage(coverage, 1500, "trusted-at-par");
    const recovered = openEvent(coverage);
    expect(coverage.lastTrustedObservationAt).toBe(1500);
    expect(coverage.gapStartedAt).toBe(900);
    expect(mergeDepegSeconds([recovered], 0, 1500)).toBe(600);
    expect(mergeUnknownDepegSeconds([recovered], 0, 1500)).toBe(300);
    expect(computePegScore([recovered], 0, 1500).pegPct).toBe(50);
    expect(hasCurrentTrustedDepegObservation(recovered, 1500)).toBe(false);

    coverage = advanceDepegPriceCoverage(coverage, 1800, "blind");
    expect(coverage.lastTrustedObservationAt).toBe(1500);
    coverage = advanceDepegPriceCoverage(coverage, 2100, "trusted-at-par");
    coverage = advanceDepegPriceCoverage(coverage, 2700, "trusted-at-par");
    const resumed = openEvent(coverage);
    expect(mergeDepegSeconds([resumed], 0, 2700)).toBe(600);
    expect(mergeUnknownDepegSeconds([resumed], 0, 2700)).toBe(900);
    expect(computePegScore([resumed], 0, 2700).pegPct).toBeCloseTo(100 * (1 - 600 / 1800));
  });

  it("extends at-par coverage at the 1200-second boundary but not across a 1201-second gap", () => {
    let coverage = advanceDepegPriceCoverage(null, 0, "trusted-at-par");
    coverage = advanceDepegPriceCoverage(coverage, 1200, "trusted-at-par");
    coverage = advanceDepegPriceCoverage(coverage, 2401, "trusted-at-par");
    const event = openEvent(coverage);
    expect(coverage.atParIntervals).toEqual([[0, 1200], [2401, 2401]]);
    expect(mergeDepegSeconds([event], 0, 2401)).toBe(0);
    expect(mergeUnknownDepegSeconds([event], 0, 2401)).toBe(1201);
    expect(computePegScore([event], 0, 2401).pegPct).toBe(100);
  });
});
