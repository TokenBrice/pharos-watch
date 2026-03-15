import { describe, it, expect } from "vitest";
import {
  scoreToGrade,
  computeOverallGrade,
  scoreDependencyRisk,
  isBlacklistable,
  GRADE_THRESHOLDS,
} from "../report-cards";

describe("scoreToGrade", () => {
  it("returns NR for null", () => {
    expect(scoreToGrade(null)).toBe("NR");
  });

  it("returns A+ for scores >= 87", () => {
    expect(scoreToGrade(87)).toBe("A+");
    expect(scoreToGrade(100)).toBe("A+");
  });

  it("returns correct grade at each threshold boundary", () => {
    for (const { grade, min } of GRADE_THRESHOLDS) {
      expect(scoreToGrade(min)).toBe(grade);
      if (min > 0) expect(scoreToGrade(min - 0.1)).not.toBe(grade);
    }
  });

  it("clamps scores to 0-100 range", () => {
    expect(scoreToGrade(-10)).toBe("F");
    expect(scoreToGrade(150)).toBe("A+");
  });

  it("returns F for score 0", () => {
    expect(scoreToGrade(0)).toBe("F");
  });
});

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
});

describe("scoreDependencyRisk", () => {
  it("scores self-backed centralized coin at 95", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      dependencies: undefined,
      reserves: undefined,
    };
    const result = scoreDependencyRisk(meta as never, new Map());
    expect(result.score).toBe(95);
  });

  it("scores self-backed decentralized coin at 90", () => {
    const meta = {
      flags: { governance: "decentralized" as const },
      dependencies: undefined,
      reserves: undefined,
    };
    const result = scoreDependencyRisk(meta as never, new Map());
    expect(result.score).toBe(90);
  });

  it("caps wrapper dependency score", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      dependencies: [{ id: "usdc", weight: 1.0, type: "wrapper" as const }],
      reserves: undefined,
    };
    const upstream = new Map([["usdc", 80]]);
    const result = scoreDependencyRisk(meta as never, upstream);
    // Wrapper cap: dep_score - 3 = 77
    expect(result.score).toBeLessThanOrEqual(77);
  });
});

describe("computeStressedGrades", () => {
  it.todo("returns modified grades for overridden coins — requires constructing full ReportCard[] shape");
});

describe("isBlacklistable", () => {
  it("returns true for centralized governance", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: undefined,
    };
    expect(isBlacklistable(meta as never)).toBe(true);
  });

  it("respects explicit override", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: false,
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });
});
