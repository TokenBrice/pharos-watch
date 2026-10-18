import { describe, expect, it } from "vitest";
import { formatBankRunGaugeScore, getLiteralMintingPressureReading, getNetFlowDirection24h, getPressureShiftState } from "../mint-burn-signals";

describe("mint-burn-signals", () => {
  it("classifies 24h net flow direction", () => {
    expect(getNetFlowDirection24h({ netFlow24hUsd: 200_000, has24hActivity: true })).toBe("minting");
    expect(getNetFlowDirection24h({ netFlow24hUsd: -200_000, has24hActivity: true })).toBe("burning");
    expect(getNetFlowDirection24h({ netFlow24hUsd: 0, has24hActivity: true })).toBe("flat");
    expect(
      getNetFlowDirection24h({
        netFlow24hUsd: 0,
        has24hActivity: false,
      }),
    ).toBe("inactive");
  });

  it("returns nr pressure state for null scores", () => {
    expect(getPressureShiftState(null)).toBe("nr");
  });

  it("pins pressure-shift state boundaries", () => {
    expect(getPressureShiftState(-10.01)).toBe("worsening");
    expect(getPressureShiftState(-10)).toBe("stable");
    expect(getPressureShiftState(10)).toBe("stable");
    expect(getPressureShiftState(10.01)).toBe("improving");
  });

  const complete = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;
  const literalScore = (mintVolume24hUsd: number, burnVolume24hUsd: number) =>
    getLiteralMintingPressureReading({ mintVolume24hUsd, burnVolume24hUsd, ...complete }).score;

  it("computes literal minting pressure from raw 24h mint vs burn balance", () => {
    expect(literalScore(105, 95)).toBeCloseTo(5, 6);
    expect(literalScore(0, 100)).toBe(-100);
  });

  it("returns NR literal minting pressure when there is no 24h activity", () => {
    expect(getLiteralMintingPressureReading({ mintVolume24hUsd: 0, burnVolume24hUsd: 0, ...complete })).toEqual({
      score: null,
      unavailableReason: "no-24h-volume",
    });
  });

  it("withholds literal minting pressure when either side is not fully valued (v6.27)", () => {
    // Lower-bound subtotals must never publish "balanced" (or any) reading.
    expect(
      getLiteralMintingPressureReading({
        mintVolume24hUsd: 100,
        burnVolume24hUsd: 100,
        mintCompleteness: "complete",
        burnCompleteness: "partial",
      }),
    ).toEqual({ score: null, unavailableReason: "valuation-partial" });
    expect(
      getLiteralMintingPressureReading({
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 0,
        mintCompleteness: "partial",
        burnCompleteness: "complete",
      }),
    ).toEqual({ score: null, unavailableReason: "valuation-partial" });
    expect(
      getLiteralMintingPressureReading({
        mintVolume24hUsd: 100,
        burnVolume24hUsd: 0,
        mintCompleteness: "unknown",
        burnCompleteness: "complete",
      }),
    ).toEqual({ score: null, unavailableReason: "valuation-unknown" });
  });

  it("gives inactivity precedence over nonzero flow", () => {
    expect(getNetFlowDirection24h({ netFlow24hUsd: 200_000, has24hActivity: false })).toBe("inactive");
    expect(getNetFlowDirection24h({ netFlow24hUsd: -200_000, has24hActivity: false })).toBe("inactive");
  });

  it("distinguishes balanced activity from mint-only activity", () => {
    expect(literalScore(100, 100)).toBe(0);
    expect(literalScore(100, 0)).toBe(100);
  });

  it("prints the gauge with one rounding and an explicit sign", () => {
    expect(formatBankRunGaugeScore(-5.64)).toBe("\u22126");
    expect(formatBankRunGaugeScore(12.4)).toBe("+12");
    expect(formatBankRunGaugeScore(-0.4)).toBe("0");
  });
});
