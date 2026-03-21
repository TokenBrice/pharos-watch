import { describe, it, expect } from "vitest";
import {
  scoreToGrade,
  computeOverallGrade,
  scoreDependencyRisk,
  scoreResilience,
  scoreDecentralization,
  chainInfraScore,
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

describe("chainInfraScore", () => {
  it("scores mature-alt-l1 single-chain at 45", () => {
    expect(chainInfraScore("mature-alt-l1", "single-chain")).toBe(45);
  });

  it("scores ethereum single-chain at 100", () => {
    expect(chainInfraScore("ethereum", "single-chain")).toBe(100);
  });
});

describe("scoreResilience (v6 — 2-factor)", () => {
  const makeMeta = (overrides: Record<string, unknown>) => ({
    flags: { backing: "rwa-backed" as const, governance: "centralized" as const },
    ...overrides,
  });

  it("uses (collateral + custody) / 2, not 3-factor", () => {
    // On-chain custody (100) + native collateral via reserves
    const meta = makeMeta({
      custodyModel: "onchain" as const,
      reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, false);
    // collateral = 100 (very-low risk), custody = 100 → avg = 100
    expect(result.score).toBe(100);
  });

  it("blacklist detail says 'descriptive only'", () => {
    const meta = makeMeta({
      custodyModel: "institutional-top" as const,
      reserves: [{ name: "T-bills", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, true);
    expect(result.detail).toContain("descriptive only");
  });

  it("produces correct scores for all 6 custody model tiers", () => {
    const expected: Record<string, number> = {
      onchain: 100,
      "institutional-top": 80,
      "institutional-regulated": 55,
      "institutional-unregulated": 30,
      "institutional-sanctioned": 5,
      cex: 0,
    };
    for (const [model, custodyScore] of Object.entries(expected)) {
      const meta = makeMeta({
        custodyModel: model,
        reserves: [{ name: "Asset", pct: 100, risk: "very-low" as const }],
      });
      const result = scoreResilience(meta as never, false);
      // collateral = 100, custody = custodyScore → avg
      expect(result.score).toBe(Math.round((100 + custodyScore) / 2));
    }
  });

  it("USDC Resilience > A7A5 Resilience", () => {
    const usdc = makeMeta({
      custodyModel: "institutional-top" as const,
      reserves: [{ name: "T-bills", pct: 100, risk: "very-low" as const }],
    });
    const a7a5 = makeMeta({
      custodyModel: "institutional-sanctioned" as const,
      reserves: [{ name: "RUB deposits (sanctioned)", pct: 100, risk: "very-high" as const }],
    });
    const usdcResult = scoreResilience(usdc as never, true);
    const a7a5Result = scoreResilience(a7a5 as never, true);
    expect(usdcResult.score).toBeGreaterThan(a7a5Result.score!);
  });

  it("LUSD-like fully on-chain coin scores 100", () => {
    const meta = makeMeta({
      flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
      custodyModel: "onchain" as const,
      reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, false);
    expect(result.score).toBe(100);
  });
});

describe("scoreDecentralization (v6 — 5-band penalty)", () => {
  const makeMeta = (chainTier: string, deploymentModel: string, governanceQuality?: string) => ({
    flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
    chainTier,
    deploymentModel,
    collateralQuality: "native" as const,
    custodyModel: "onchain" as const,
    ...(governanceQuality ? { governanceQuality } : {}),
  });

  it("applies -10 penalty for infraScore 60-79", () => {
    // stage1-l2 (66) × canonical-bridge (0.90) = 59 → band 40-59 → -25
    // Actually 59.4 rounds to 59, so >= 40 → -25. Let me use a better example.
    // mature-alt-l1 (45) × single-chain (1.0) = 45 → band 40-59 → -25
    // For 60-79: stage1-l2 (66) × single-chain (1.0) = 66 → band 60-79 → -10
    const meta = makeMeta("stage1-l2", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-10) = 75
    expect(result.score).toBe(75);
  });

  it("applies -25 penalty for infraScore 40-59", () => {
    // mature-alt-l1 (45) × single-chain (1.0) = 45 → band 40-59 → -25
    const meta = makeMeta("mature-alt-l1", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-25) = 60
    expect(result.score).toBe(60);
  });

  it("applies -40 penalty for infraScore 20-39", () => {
    // established-alt-l1 (20) × single-chain (1.0) = 20 → band 20-39 → -40
    const meta = makeMeta("established-alt-l1", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-40) = 45
    expect(result.score).toBe(45);
  });

  it("applies -60 penalty for infraScore 0-19", () => {
    // unproven (0) × single-chain (1.0) = 0 → band <20 → -60
    const meta = makeMeta("unproven", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-60) = 25
    expect(result.score).toBe(25);
  });

  it("exempts wrapper governance from chain penalty", () => {
    const meta = makeMeta("unproven", "single-chain", "wrapper");
    const result = scoreDecentralization("centralized-dependent", meta as never);
    // wrapper (10) with no penalty applied
    expect(result.score).toBe(10);
  });
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
