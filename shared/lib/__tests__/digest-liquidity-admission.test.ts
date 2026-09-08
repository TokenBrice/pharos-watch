import { describe, expect, it } from "vitest";
import { admitLiquidityShift, type LiquidityShiftSnapshot } from "../digest-liquidity-admission";

const DAY = 86_400;
const YESTERDAY = 1_787_184_000;

function snapshot(overrides: Partial<LiquidityShiftSnapshot> = {}): LiquidityShiftSnapshot {
  return {
    snapshotDate: YESTERDAY,
    liquidityScore: 58,
    totalTvlUsd: 152_000_000,
    coverageClass: "primary",
    coverageConfidence: 0.9,
    methodologyVersion: "6.0",
    ...overrides,
  };
}

describe("admitLiquidityShift", () => {
  it("admits an adjacent, primary-coverage, same-methodology pair", () => {
    const result = admitLiquidityShift(
      snapshot({ liquidityScore: 52, totalTvlUsd: 120_000_000 }),
      snapshot({ snapshotDate: YESTERDAY - DAY }),
    );

    expect(result.admissible).toBe(true);
    expect(result.rejection).toBeUndefined();
    expect(result.tvlChangePct).toBeCloseTo(-0.2105, 4);
  });

  it("admits a comparable 91% collapse and leaves the verdict downstream", () => {
    // Admission decides comparability only. Rejecting on magnitude here would
    // also have discarded a genuine 91% drain unread; only the candidate layer
    // can see whether prices, flows, or supply corroborate it.
    const result = admitLiquidityShift(
      snapshot({ liquidityScore: 46, totalTvlUsd: 13_720_000 }),
      snapshot({ snapshotDate: YESTERDAY - DAY }),
    );

    expect(result.admissible).toBe(true);
    expect(result.tvlChangePct).toBeCloseTo(-0.9097, 4);
    // Comparability is independent of magnitude; log-scale TVL depth explains
    // about eleven composite points even for this 91% drain.
    expect(result.expectedScoreDeltaFromTvl).toBeCloseTo(-10.98, 1);
  });


  it("rejects a pair whose rows are not one day apart", () => {
    const result = admitLiquidityShift(
      snapshot({ totalTvlUsd: 140_000_000 }),
      snapshot({ snapshotDate: YESTERDAY - 3 * DAY }),
    );

    expect(result.rejection).toBe("non-adjacent-snapshots");
  });

  it("rejects a pair that straddles a methodology version change", () => {
    // v6.0 shipped the Raydium double-count correction on 2026-08-20 and moved
    // USDS 58 -> 46 with no on-chain change. A recompute is not a market move.
    const result = admitLiquidityShift(
      snapshot({ liquidityScore: 46, totalTvlUsd: 120_000_000, methodologyVersion: "6.0" }),
      snapshot({ snapshotDate: YESTERDAY - DAY, liquidityScore: 58, methodologyVersion: "5.91" }),
    );

    expect(result.rejection).toBe("methodology-basis-change");
  });

  it("rejects fallback-sourced and low-confidence rows on either side", () => {
    expect(
      admitLiquidityShift(
        snapshot({ coverageClass: "fallback", totalTvlUsd: 120_000_000 }),
        snapshot({ snapshotDate: YESTERDAY - DAY }),
      ).rejection,
    ).toBe("non-trendworthy-coverage");

    expect(
      admitLiquidityShift(
        snapshot({ totalTvlUsd: 120_000_000 }),
        snapshot({ snapshotDate: YESTERDAY - DAY, coverageConfidence: 0.5 }),
      ).rejection,
    ).toBe("non-trendworthy-coverage");
  });

  it("rejects non-finite measurements instead of ranking them", () => {
    const result = admitLiquidityShift(
      snapshot({ totalTvlUsd: Number.NaN }),
      snapshot({ snapshotDate: YESTERDAY - DAY }),
    );

    expect(result.admissible).toBe(false);
  });

  it("admits a large TVL gain, which is not the failure mode being gated", () => {
    const result = admitLiquidityShift(
      snapshot({ liquidityScore: 70, totalTvlUsd: 400_000_000 }),
      snapshot({ snapshotDate: YESTERDAY - DAY }),
    );

    expect(result.admissible).toBe(true);
    expect(result.expectedScoreDeltaFromTvl).toBeGreaterThan(0);
  });
});
