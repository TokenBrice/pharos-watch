import { describe, it, expect } from "vitest";
import { scoreToGrade, computeOverallGrade, applyVariantOverallCap } from "../report-cards";
import {
  activeDepegCapScore,
  ACTIVE_DEPEG_CAP_F_BPS,
  ACTIVE_DEPEG_CAP_D_BPS,
  ACTIVE_DEPEG_CAP_F_SCORE,
  ACTIVE_DEPEG_CAP_D_SCORE,
} from "../report-card-active-depeg";

describe("computeOverallGrade", () => {
  const makeDimension = (score: number | null) => ({
    grade: score !== null ? scoreToGrade(score) : ("NR" as const),
    score,
    detail: "test",
  });

  it("returns NR when fewer than 2 base dimensions are rated", () => {
    const dims = {
      pegStability: makeDimension(90),
      liquidity: makeDimension(null),
      resilience: makeDimension(null),
      decentralization: makeDimension(null),
      dependencyRisk: makeDimension(null),
    };
    const result = computeOverallGrade(dims as never);
    expect(result.grade).toBe("NR");
  });

  it("computes a grade when 2+ base dimensions are rated", () => {
    const dims = {
      pegStability: makeDimension(90),
      liquidity: makeDimension(80),
      resilience: makeDimension(75),
      decentralization: makeDimension(70),
      dependencyRisk: makeDimension(85),
    };
    const result = computeOverallGrade(dims as never);
    expect(result.grade).not.toBe("NR");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("keeps unrated NAV tokens neutral when peg stability is genuinely not applicable", () => {
    const dims = {
      pegStability: makeDimension(null),
      liquidity: makeDimension(80),
      resilience: makeDimension(75),
      decentralization: makeDimension(70),
      dependencyRisk: makeDimension(85),
    };
    const result = computeOverallGrade(dims as never, { navToken: true });

    expect(result.grade).not.toBe("NR");
    expect(result.baseScore).toBe(78.6);
    expect(result.score).toBe(79);
  });

  it("penalizes NAV wrappers when peg stability is provided", () => {
    const dims = {
      pegStability: makeDimension(82),
      liquidity: makeDimension(80),
      resilience: makeDimension(75),
      decentralization: makeDimension(70),
      dependencyRisk: makeDimension(85),
    };
    const neutral = computeOverallGrade(
      {
        ...dims,
        pegStability: makeDimension(null),
      } as never,
      { navToken: true },
    );
    const result = computeOverallGrade(dims as never, { navToken: true });

    expect(result.grade).not.toBe("NR");
    expect(result.baseScore).toBe(neutral.baseScore);
    expect(result.score).toBeLessThan(neutral.score ?? Infinity);
    expect(result.score).toBe(73);
  });
});

describe("computeOverallGrade — active depeg cap", () => {
  const makeDimension = (score: number | null) => ({
    grade: score !== null ? scoreToGrade(score) : ("NR" as const),
    score,
    detail: "test",
  });

  const highBaseDims = {
    pegStability: makeDimension(50),
    liquidity: makeDimension(90),
    resilience: makeDimension(90),
    decentralization: makeDimension(80),
    dependencyRisk: makeDimension(95),
  };

  it("caps at F (39) for active depeg >= 2500 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 7600 });
    expect(result.score).toBeLessThanOrEqual(39);
    expect(result.grade).toBe("F");
  });

  it("caps at D (49) for active depeg >= 1000 bps but < 2500 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 1500 });
    expect(result.score).toBeLessThanOrEqual(49);
    expect(result.grade).not.toBe("NR");
    expect(["D", "F"]).toContain(result.grade);
  });

  it("does not cap for active depeg < 1000 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 500 });
    const uncapped = computeOverallGrade(highBaseDims as never);
    expect(result.score).toBe(uncapped.score);
  });

  it("does not cap when activeDepegBps is null", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: null });
    const uncapped = computeOverallGrade(highBaseDims as never);
    expect(result.score).toBe(uncapped.score);
  });

  it("does not cap when activeDepegBps is not provided", () => {
    const result = computeOverallGrade(highBaseDims as never);
    expect(result.score).not.toBeNull();
  });
});

describe("applyVariantOverallCap", () => {
  const base = {
    grade: "A" as const,
    score: 88,
    baseScore: 87.5,
    ratedDimensions: 5,
  };

  it("caps the child score at the parent and records the pre-cap value (live-cap path)", () => {
    const result = applyVariantOverallCap(base, 72);
    expect(result.overallCapped).toBe(true);
    expect(result.score).toBe(72);
    expect(result.grade).toBe(scoreToGrade(72));
    expect(result.uncappedOverallScore).toBe(88);
    expect(result.baseScore).toBe(base.baseScore);
  });

  it("skips the cap and leaves the child untouched when the parent is unrated", () => {
    const result = applyVariantOverallCap(base, null);
    expect(result.overallCapped).toBe(false);
    expect(result.score).toBe(88);
    expect(result.grade).toBe(base.grade);
    expect(result.uncappedOverallScore).toBeNull();
    expect(result.baseScore).toBe(base.baseScore);
  });

  it("skips the cap when the child already scores at or below the parent", () => {
    const equalCap = applyVariantOverallCap(base, 88);
    expect(equalCap.overallCapped).toBe(false);
    expect(equalCap.score).toBe(88);
    expect(equalCap.uncappedOverallScore).toBeNull();

    const underCap = applyVariantOverallCap(base, 95);
    expect(underCap.overallCapped).toBe(false);
    expect(underCap.score).toBe(88);
    expect(underCap.uncappedOverallScore).toBeNull();
  });

  it("skips the cap when the child score is null", () => {
    const result = applyVariantOverallCap({ grade: "NR", score: null, baseScore: null, ratedDimensions: 0 }, 72);
    expect(result.overallCapped).toBe(false);
    expect(result.score).toBeNull();
    expect(result.uncappedOverallScore).toBeNull();
  });
});

describe("activeDepegCapScore", () => {
  it("returns null for null input", () => {
    expect(activeDepegCapScore(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(activeDepegCapScore(undefined)).toBeNull();
  });

  it("returns null for bps below D threshold (999 bps)", () => {
    expect(activeDepegCapScore(999)).toBeNull();
    expect(activeDepegCapScore(0)).toBeNull();
  });

  it("returns D cap score at exactly the D boundary", () => {
    expect(activeDepegCapScore(ACTIVE_DEPEG_CAP_D_BPS)).toBe(ACTIVE_DEPEG_CAP_D_SCORE);
  });

  it("returns D cap score just below F threshold", () => {
    expect(activeDepegCapScore(ACTIVE_DEPEG_CAP_F_BPS - 1)).toBe(ACTIVE_DEPEG_CAP_D_SCORE);
  });

  it("returns F cap score at exactly the F boundary", () => {
    expect(activeDepegCapScore(ACTIVE_DEPEG_CAP_F_BPS)).toBe(ACTIVE_DEPEG_CAP_F_SCORE);
  });

  it("returns F cap score for large values above F boundary", () => {
    expect(activeDepegCapScore(7600)).toBe(ACTIVE_DEPEG_CAP_F_SCORE);
  });
});
