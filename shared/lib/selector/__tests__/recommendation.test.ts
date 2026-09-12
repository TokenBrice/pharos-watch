import { describe, expect, it } from "vitest";
import { whyKeyTriggers } from "../recommendation";
import type { MergedRow } from "../types";

/** Only the fields the yield why-keys read; `MergedRow` requires a full row. */
function makeYieldRow(overrides: Partial<MergedRow>): MergedRow {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    pharosYieldScore: null,
    apy30d: null,
    benchmarkRate: null,
    apyVariance30d: null,
    warningSignals: [],
    ...overrides,
  } as unknown as MergedRow;
}

describe("why-key calibration", () => {
  // B38: the `top-pys` cut was calibrated to the pre-rescale distribution and
  // qualified 1 of 156 live rows. The live histogram on the current PYS scale
  // tops out at 85 with mass at 10-24, so the re-anchored cut is 50 (4 rows,
  // ~2.5% selectivity).
  it.each([
    [null, false],
    [49.9, false],
    [50, true],
    [85, true],
  ])("top-pys at pharosYieldScore %s -> %s", (pharosYieldScore, expected) => {
    expect(whyKeyTriggers("top-pys", makeYieldRow({ pharosYieldScore }))).toBe(expected);
  });

  it("does not fire adjacent yield why-keys on the same reading", () => {
    const row = makeYieldRow({ pharosYieldScore: 50 });
    expect(whyKeyTriggers("yield-above-benchmark", row)).toBe(false);
    expect(whyKeyTriggers("low-variance", row)).toBe(false);
  });
});
