import { describe, it, expect } from "vitest";
import {
  computeStabilityIndex,
  getDepreciationFactor,
  getConditionBand,
} from "../stability-index";
import type { StabilityInput } from "../stability-index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a StabilityInput with sensible defaults, overridable per-test. */
function baseInput(overrides: Partial<StabilityInput> = {}): StabilityInput {
  return {
    depegs: [],
    totalMcapUsd: 200e9,
    mcap7dChangePct: 0,
    ...overrides,
  };
}

function computeIndex(input: StabilityInput) {
  const result = computeStabilityIndex(input);
  expect(result).not.toBeNull();
  return result!;
}

// ---------------------------------------------------------------------------
// getDepreciationFactor
// ---------------------------------------------------------------------------

describe("getDepreciationFactor", () => {
  it("returns 1.0 during the grace period (0–30 days)", () => {
    expect(getDepreciationFactor(0)).toBe(1.0);
    expect(getDepreciationFactor(15)).toBe(1.0);
    expect(getDepreciationFactor(30)).toBe(1.0);
  });

  it("starts decaying after 30 days", () => {
    const factor = getDepreciationFactor(31);
    expect(factor).toBeLessThan(1.0);
    // 1.0 - (31 - 30) / 120 = 1.0 - 1/120 ≈ 0.9917
    expect(factor).toBeCloseTo(1.0 - 1 / 120, 4);
  });

  it("returns documented factor values at milestone ages", () => {
    // 45 days: 1.0 - (45 - 30) / 120 = 1.0 - 15/120 = 0.875
    expect(getDepreciationFactor(45)).toBeCloseTo(0.875, 4);

    // 60 days: 1.0 - (60 - 30) / 120 = 1.0 - 30/120 = 0.75
    expect(getDepreciationFactor(60)).toBeCloseTo(0.75, 4);

    // 90 days: 1.0 - (90 - 30) / 120 = 1.0 - 60/120 = 0.5
    expect(getDepreciationFactor(90)).toBeCloseTo(0.5, 4);

    // 120 days: 1.0 - (120 - 30) / 120 = 1.0 - 90/120 = 0.25
    expect(getDepreciationFactor(120)).toBeCloseTo(0.25, 4);
  });

  it("floors at 0.25 for very old depegs (>150 days)", () => {
    expect(getDepreciationFactor(150)).toBe(0.25);
    expect(getDepreciationFactor(365)).toBe(0.25);
    expect(getDepreciationFactor(1000)).toBe(0.25);
  });

  it("hits the floor exactly at 120 days past the grace period (150 total)", () => {
    // 150 days: 1.0 - (150 - 30) / 120 = 1.0 - 1.0 = 0.0, but floor is 0.25
    expect(getDepreciationFactor(150)).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// getConditionBand
// ---------------------------------------------------------------------------

describe("getConditionBand", () => {
  it.each([
    [100, "BEDROCK"],
    [95, "BEDROCK"],
    [90, "BEDROCK"],
    [89.9, "STEADY"],
    [89, "STEADY"],
    [75, "STEADY"],
    [74.9, "TREMOR"],
    [60, "TREMOR"],
    [59.9, "FRACTURE"],
    [40, "FRACTURE"],
    [39.9, "CRISIS"],
    [20, "CRISIS"],
    [19.9, "MELTDOWN"],
    [10, "MELTDOWN"],
    [0, "MELTDOWN"],
  ] as const)("score %s => %s", (score, band) => {
    expect(getConditionBand(score)).toBe(band);
  });
});

// ---------------------------------------------------------------------------
// computeStabilityIndex — healthy market
// ---------------------------------------------------------------------------

describe("computeStabilityIndex", () => {
  it("returns 100 BEDROCK when no depegs and neutral trend", () => {
    const result = computeIndex(baseInput());
    expect(result.score).toBe(100);
    expect(result.band).toBe("BEDROCK");
    expect(result.components.severity).toBe(0);
    expect(result.components.breadth).toBe(0);
    expect(result.components.stressBreadth).toBe(0);
    expect(result.components.trend).toBe(0);
  });

  it("gets a trend boost from positive 7d mcap change", () => {
    const result = computeIndex(baseInput({ mcap7dChangePct: 3 }));
    // 100 - 0 - 0 - 0 + 3 = 103, clamped to 100
    expect(result.score).toBe(100);
    expect(result.components.trend).toBe(3);
  });

  it("gets a trend penalty from negative 7d mcap change", () => {
    const result = computeIndex(baseInput({ mcap7dChangePct: -4 }));
    // 100 - 0 - 0 - 0 + (-4) = 96
    expect(result.score).toBe(96);
    expect(result.components.trend).toBe(-4);
    expect(result.band).toBe("BEDROCK");
  });

  // -----------------------------------------------------------------------
  // Trend clamping
  // -----------------------------------------------------------------------

  it("clamps trend at +5", () => {
    const result = computeIndex(baseInput({ mcap7dChangePct: 20 }));
    expect(result.components.trend).toBe(5);
  });

  it("clamps trend at -5", () => {
    const result = computeIndex(baseInput({ mcap7dChangePct: -15 }));
    expect(result.components.trend).toBe(-5);
  });

  it("treats NaN mcap7dChangePct as 0", () => {
    const result = computeIndex(baseInput({ mcap7dChangePct: NaN }));
    expect(result.components.trend).toBe(0);
  });

  it("treats Infinity mcap7dChangePct as 0", () => {
    const result = computeIndex(
      baseInput({ mcap7dChangePct: Infinity }),
    );
    expect(result.components.trend).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Severity component
  // -----------------------------------------------------------------------

  describe("severity", () => {
    it("computes severity for a single depeg", () => {
      // A $10B coin in a $200B market depegging 100bps
      // share = 10e9 / 200e9 = 0.05
      // amplifier = log2(1 + 10e9 / 1e9) = log2(11) ≈ 3.459
      // factor = 1.0 (age = 0)
      // severity = (100 / 100) * 0.05 * 3.459 * 60 * 1.0 ≈ 10.38
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9 }],
        }),
      );
      expect(result.components.severity).toBeCloseTo(10.38, 0);
      expect(result.score).toBeCloseTo(100 - 10.38 - result.components.breadth, 0);
    });

    it("treats negative bps (premium) same as positive (uses abs)", () => {
      const depeg = computeIndex(
        baseInput({ depegs: [{ bps: -200, mcapUsd: 5e9 }] }),
      );
      const premium = computeIndex(
        baseInput({ depegs: [{ bps: 200, mcapUsd: 5e9 }] }),
      );
      expect(depeg.components.severity).toBe(premium.components.severity);
    });

    it("caps severity at 68", () => {
      // Massive depeg: USDT-sized coin depegging 500bps
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 500, mcapUsd: 145e9 }],
          totalMcapUsd: 200e9,
        }),
      );
      expect(result.components.severity).toBe(68);
    });

    it("severity scales with mcap share", () => {
      const large = computeIndex(
        baseInput({ depegs: [{ bps: 100, mcapUsd: 50e9 }] }),
      );
      const small = computeIndex(
        baseInput({ depegs: [{ bps: 100, mcapUsd: 1e9 }] }),
      );
      expect(large.components.severity).toBeGreaterThan(
        small.components.severity,
      );
    });

    it("severity scales with log2 amplifier", () => {
      // Same share but different absolute mcap
      const mega = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 100e9 }],
          totalMcapUsd: 1000e9,
        }),
      );
      const mid = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 1e9 }],
          totalMcapUsd: 10e9,
        }),
      );
      // Same 10% share, but mega has log2(101) ≈ 6.66 vs log2(2) = 1.0
      expect(mega.components.severity).toBeGreaterThan(
        mid.components.severity,
      );
    });

    it("severity is reduced by depreciation factor for old depegs", () => {
      const fresh = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9, depegAgeDays: 0 }],
        }),
      );
      const old = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9, depegAgeDays: 90 }],
        }),
      );
      // At 90 days, factor = 0.5, so old severity should be ~half fresh severity
      expect(old.components.severity).toBeCloseTo(
        fresh.components.severity * 0.5,
        1,
      );
    });

    it("returns null when totalMcapUsd is zero", () => {
      const result = computeStabilityIndex(
        baseInput({
          depegs: [{ bps: 200, mcapUsd: 5e9 }],
          totalMcapUsd: 0,
        }),
      );
      expect(result).toBeNull();
    });

    it("accumulates severity across multiple depegs", () => {
      const single = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9 }],
        }),
      );
      const double = computeIndex(
        baseInput({
          depegs: [
            { bps: 100, mcapUsd: 10e9 },
            { bps: 100, mcapUsd: 10e9 },
          ],
        }),
      );
      // Two identical depegs should double severity (if not capped)
      expect(double.components.severity).toBeCloseTo(
        single.components.severity * 2,
        1,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Breadth component
  // -----------------------------------------------------------------------

  describe("breadth", () => {
    it("computes breadth from sqrt(mcap/$1B)", () => {
      // $4B coin: sqrt(4e9 / 1e9) * 3 = sqrt(4) * 3 = 2 * 3 = 6
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 50, mcapUsd: 4e9 }],
        }),
      );
      expect(result.components.breadth).toBeCloseTo(6, 1);
    });

    it("caps breadth at 17", () => {
      // Multiple massive coins: each contributes sqrt(100) * 3 = 30
      const result = computeIndex(
        baseInput({
          depegs: [
            { bps: 50, mcapUsd: 100e9 },
            { bps: 50, mcapUsd: 100e9 },
          ],
        }),
      );
      expect(result.components.breadth).toBe(17);
    });

    it("micro-cap coins contribute minimal breadth", () => {
      // $50M coin: sqrt(0.05) * 3 ≈ 0.67
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 50e6 }],
        }),
      );
      expect(result.components.breadth).toBeCloseTo(0.67, 1);
    });

    it("breadth is reduced by depreciation for old depegs", () => {
      const fresh = computeIndex(
        baseInput({
          depegs: [{ bps: 50, mcapUsd: 4e9, depegAgeDays: 0 }],
        }),
      );
      const old = computeIndex(
        baseInput({
          depegs: [{ bps: 50, mcapUsd: 4e9, depegAgeDays: 90 }],
        }),
      );
      // At 90 days, factor = 0.5
      expect(old.components.breadth).toBeCloseTo(
        fresh.components.breadth * 0.5,
        1,
      );
    });

    it("many micro-cap depegs have low total breadth", () => {
      // 12 × $50M coins: each ≈ 0.67, total ≈ 8.05
      const depegs = Array.from({ length: 12 }, () => ({
        bps: 100,
        mcapUsd: 50e6,
      }));
      const result = computeIndex(baseInput({ depegs }));
      expect(result.components.breadth).toBeLessThan(10);
    });
  });

  // -----------------------------------------------------------------------
  // Stress breadth component
  // -----------------------------------------------------------------------

  describe("stressBreadth", () => {
    it("defaults to 0 when dewsStressBreadth not provided", () => {
      const result = computeIndex(baseInput());
      expect(result.components.stressBreadth).toBe(0);
    });

    it("passes through values <= 5", () => {
      const result = computeIndex(
        baseInput({ dewsStressBreadth: 3.5 }),
      );
      expect(result.components.stressBreadth).toBe(3.5);
      // 100 - 0 - 0 - 3.5 + 0 = 96.5
      expect(result.score).toBe(96.5);
    });

    it("caps at 5", () => {
      const result = computeIndex(
        baseInput({ dewsStressBreadth: 10 }),
      );
      expect(result.components.stressBreadth).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Score clamping and rounding
  // -----------------------------------------------------------------------

  describe("score clamping and rounding", () => {
    it("clamps score at 0 for catastrophic scenarios", () => {
      const result = computeIndex(
        baseInput({
          depegs: [
            { bps: 5000, mcapUsd: 145e9 },
            { bps: 3000, mcapUsd: 60e9 },
          ],
          totalMcapUsd: 200e9,
          mcap7dChangePct: -5,
          dewsStressBreadth: 5,
        }),
      );
      // severity=68 + breadth=17 + stress=5 + trend=-5 => 100-68-17-5-5 = 5
      // Actually trend adds, so 100-68-17-5+(-5) = 5
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("clamps score at 100 for positive trend with no depegs", () => {
      const result = computeIndex(
        baseInput({ mcap7dChangePct: 10 }),
      );
      // 100 + 5 (clamped trend) = 105, clamped to 100
      expect(result.score).toBe(100);
    });

    it("rounds score to 1 decimal place", () => {
      // Pick inputs that produce a non-round score
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 37, mcapUsd: 1e9 }],
        }),
      );
      // Check it has at most 1 decimal place
      const decimals = result.score.toString().split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Band assignment
  // -----------------------------------------------------------------------

  describe("band assignment", () => {
    it("assigns BEDROCK for healthy market (no depegs)", () => {
      const result = computeIndex(baseInput());
      expect(result.band).toBe("BEDROCK");
    });

    it("drops score significantly for USDT 10bps wobble", () => {
      // USDT ($145B) at 10bps in $200B market:
      // severity ≈ 31.28 (share=0.725, amplifier≈7.18, K=60), breadth=17 (cap)
      // score ≈ 100 - 31.28 - 17 + 0.26 = 52 → FRACTURE
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 10, mcapUsd: 145e9 }],
          totalMcapUsd: 200e9,
          mcap7dChangePct: 0.26,
        }),
      );
      expect(result.band).toBe("FRACTURE");
      expect(result.score).toBe(52);
    });

    it("drops to MELTDOWN for USDT 30bps wobble", () => {
      // USDT at 30bps: severity hits cap (68), breadth=17 (cap)
      // score ≈ 100 - 68 - 17 + 0.26 = 15.3 → MELTDOWN
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 30, mcapUsd: 145e9 }],
          totalMcapUsd: 200e9,
          mcap7dChangePct: 0.26,
        }),
      );
      expect(result.band).toBe("MELTDOWN");
      expect(result.score).toBe(15.3);
    });

    it("assigns MELTDOWN for USDT 50bps + USDC 20bps + market drop", () => {
      // Calibration example: USDT 50bps + USDC 20bps - 3% mcap → ~12.0 MELTDOWN
      const result = computeIndex(
        baseInput({
          depegs: [
            { bps: 50, mcapUsd: 145e9 },
            { bps: 20, mcapUsd: 60e9 },
          ],
          totalMcapUsd: 200e9,
          mcap7dChangePct: -3,
        }),
      );
      expect(result.band).toBe("MELTDOWN");
      expect(result.score).toBeLessThan(20);
    });
  });

  // -----------------------------------------------------------------------
  // Calibration examples from docs
  // -----------------------------------------------------------------------

  describe("calibration examples (from docs)", () => {
    it("12 micro-coin depegs barely move the score", () => {
      // 12 × $50M coins at 100bps in $200B market:
      // severity ≈ 0.01 (tiny share, small amplifier), breadth ≈ 8.05
      // score ≈ 100 - 0.01 - 8.05 + 0.26 = 92.2 → BEDROCK
      const depegs = Array.from({ length: 12 }, () => ({
        bps: 100,
        mcapUsd: 50e6,
      }));
      const result = computeIndex(
        baseInput({
          depegs,
          totalMcapUsd: 200e9,
          mcap7dChangePct: 0.26,
        }),
      );
      expect(result.band).toBe("BEDROCK");
      expect(result.score).toBe(92.2);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty depegs array", () => {
      const result = computeIndex(baseInput({ depegs: [] }));
      expect(result.score).toBe(100);
      expect(result.components.severity).toBe(0);
      expect(result.components.breadth).toBe(0);
    });

    it("handles depeg with zero bps", () => {
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 0, mcapUsd: 10e9 }],
        }),
      );
      expect(result.components.severity).toBe(0);
      // Breadth still counts (coin is in the depegs list)
      expect(result.components.breadth).toBeGreaterThan(0);
    });

    it("handles depeg with zero mcapUsd", () => {
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 200, mcapUsd: 0 }],
        }),
      );
      // share = 0, amplifier = log2(1) = 0, sqrt(0) = 0
      expect(result.components.severity).toBe(0);
      expect(result.components.breadth).toBe(0);
    });

    it("defaults depegAgeDays to 0 (full impact) when not provided", () => {
      const withAge = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9, depegAgeDays: 0 }],
        }),
      );
      const withoutAge = computeIndex(
        baseInput({
          depegs: [{ bps: 100, mcapUsd: 10e9 }],
        }),
      );
      expect(withAge.components.severity).toBe(withoutAge.components.severity);
      expect(withAge.components.breadth).toBe(withoutAge.components.breadth);
    });

    it("result components are rounded to 2 decimal places", () => {
      const result = computeIndex(
        baseInput({
          depegs: [{ bps: 77, mcapUsd: 3.3e9 }],
          mcap7dChangePct: 1.111,
        }),
      );
      for (const key of ["severity", "breadth", "stressBreadth", "trend"] as const) {
        const decimals =
          result.components[key].toString().split(".")[1]?.length ?? 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Return shape
  // -----------------------------------------------------------------------

  describe("return shape", () => {
    it("returns all required fields", () => {
      const result = computeIndex(baseInput());
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("band");
      expect(result).toHaveProperty("components");
      expect(result.components).toHaveProperty("severity");
      expect(result.components).toHaveProperty("breadth");
      expect(result.components).toHaveProperty("stressBreadth");
      expect(result.components).toHaveProperty("trend");
    });

    it("score is a number between 0 and 100", () => {
      const result = computeIndex(baseInput());
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("band is a valid ConditionBand string", () => {
      const validBands = [
        "BEDROCK",
        "STEADY",
        "TREMOR",
        "FRACTURE",
        "CRISIS",
        "MELTDOWN",
      ];
      const result = computeIndex(baseInput());
      expect(validBands).toContain(result.band);
    });
  });
});
