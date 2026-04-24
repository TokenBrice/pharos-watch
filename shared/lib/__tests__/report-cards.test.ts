import { describe, it, expect } from "vitest";
import { createReportCardRawInputs } from "../report-card-raw-inputs";
import { deriveEffectiveDependencies } from "../dependency-derivation";
import {
  scoreLiquidity,
  scoreToGrade,
  computeOverallGrade,
  computeStressedGrades,
  scoreDependencyRisk,
  scoreResilience,
  scoreDecentralization,
  applyVariantOverallCap,
  chainInfraScore,
  getBlacklistStatusLabel,
  isBlacklistable,
  enrichLiveSlicesForBlacklist,
  GRADE_THRESHOLDS,
  resolveBlacklistStatuses,
  PEG_MULTIPLIER_EXPONENT,
} from "../report-cards";
import type { ReportCard } from "../../types/report-cards";

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

describe("PEG_MULTIPLIER_EXPONENT", () => {
  it("is 0.4", () => {
    expect(PEG_MULTIPLIER_EXPONENT).toBe(0.4);
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
    const neutral = computeOverallGrade({
      ...dims,
      pegStability: makeDimension(null),
    } as never, { navToken: true });
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

describe("scoreDependencyRisk", () => {
  it("scores self-backed centralized coin at 95", () => {
    const result = scoreDependencyRisk({
      governance: "centralized",
      dependencies: [],
    }, new Map());
    expect(result.score).toBe(95);
  });

  it("scores self-backed decentralized coin at 90", () => {
    const result = scoreDependencyRisk({
      governance: "decentralized",
      dependencies: [],
    }, new Map());
    expect(result.score).toBe(90);
  });

  it("caps wrapper dependency score", () => {
    const upstream = new Map([["usdc", 80]]);
    const result = scoreDependencyRisk({
      governance: "centralized",
      dependencies: [{ id: "usdc", weight: 1.0, type: "wrapper" }],
    }, upstream);
    // Wrapper cap: dep_score - 3 = 77
    expect(result.score).toBeLessThanOrEqual(77);
  });

  it("scores partially unavailable dependency weights at the conservative fallback", () => {
    const result = scoreDependencyRisk({
      governance: "centralized",
      dependencies: [
        { id: "available", weight: 0.5, type: "collateral" as const },
        { id: "missing", weight: 0.3, type: "collateral" as const },
      ],
    }, new Map([["available", 90]]));

    // 50% * 90 + 30% * 70 + 20% self-backed centralized score 95 = 85, then
    // the unavailable dependency is treated as weak (<75), applying -10.
    expect(result.score).toBe(75);
    expect(result.detail).toContain("Unavailable upstream scores: 1 dep");
  });

  it("uses the wider risk-absorption wrapper ceiling for tracked variants", () => {
    const result = scoreDependencyRisk({
      governance: "centralized-dependent",
      dependencies: [{ id: "usds-sky", weight: 1, type: "wrapper" }],
      variantParentId: "usds-sky",
      variantKind: "risk-absorption",
    }, new Map([["usds-sky", 80]]));

    expect(result.score).toBe(75);
  });

  it("uses the strategy-vault wrapper ceiling for tracked strategy variants", () => {
    const result = scoreDependencyRisk({
      governance: "centralized-dependent",
      dependencies: [{ id: "usdai-usd-ai", weight: 1, type: "wrapper" }],
      variantParentId: "usdai-usd-ai",
      variantKind: "strategy-vault",
    }, new Map([["usdai-usd-ai", 80]]));

    expect(result.score).toBe(75);
  });

  it("uses the strictest wrapper ceiling for bond-maturity variants", () => {
    const result = scoreDependencyRisk({
      governance: "centralized-dependent",
      dependencies: [{ id: "usd0-usual", weight: 1, type: "wrapper" }],
      variantParentId: "usd0-usual",
      variantKind: "bond-maturity",
    }, new Map([["usd0-usual", 95]]));

    expect(result.score).toBe(87);
  });

  it("applies live-derived mechanism dependency ceilings", () => {
    const dependencies = deriveEffectiveDependencies(
      {
        reserves: [{ name: "Curated stablecoin", pct: 100, risk: "low", coinId: "curated" }],
        dependencies: [],
      },
      {
        liveReserveSlices: [
          { name: "Live mechanism stablecoin", pct: 40, risk: "low", coinId: "live", depType: "mechanism" },
          { name: "Self-backed reserve", pct: 60, risk: "very-low" },
        ],
      },
    );

    const result = scoreDependencyRisk({
      governance: "centralized",
      dependencies,
    }, new Map([["live", 50]]));

    expect(result.score).toBe(50);
  });
});

describe("scoreLiquidity", () => {
  it("treats configured but unrated redemption routes as NR with explicit detail", () => {
    const result = scoreLiquidity(undefined, {
      score: null,
      routeFamily: "queue-redeem",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      resolutionState: "missing-capacity",
      modelConfidence: "medium",
      capacitySemantics: "immediate-bounded",
    });

    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("configured but currently unrated");
  });

  it("blends DEX liquidity with a resolved redemption backstop score", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
      },
    );

    expect(result.grade).not.toBe("NR");
    expect(result.score).toBeGreaterThan(40);
    expect(result.detail).toContain("Effective exit score");
    expect(result.detail).toContain("Redemption backstop");
    expect(result.detail).toContain("Stablecoin redeem");
  });

  it("uses raw redemption score when only redemption exists (no cap)", () => {
    const result = scoreLiquidity(undefined, {
      score: 90,
      routeFamily: "collateral-redeem",
      immediateCapacityUsd: 100_000_000,
      immediateCapacityRatio: 1.0,
      resolutionState: "resolved",
      modelConfidence: "medium",
      capacitySemantics: "immediate-bounded",
    });

    // Best-path model: redemption-only uses raw score (no cap/discount)
    expect(result.score).toBe(90);
    expect(result.detail).toContain("DEX liquidity unavailable");
    expect(result.detail).toContain("Redemption backstop 90/100");
  });

  it("high DEX liquidity dominates over low redemption score", () => {
    const result = scoreLiquidity(
      { liquidityScore: 95, concentrationHhi: 0.1, poolCount: 10, chainCount: 3 },
      {
        score: 30,
        routeFamily: "queue-redeem",
        immediateCapacityUsd: 1_000_000,
        immediateCapacityRatio: 0.1,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
      },
    );

    // Best-path: max(95, 30) + min(95, 30) × 0.10 = 95 + 3 = 98
    expect(result.score).toBe(98);
  });

  it("does not let low-confidence redemption uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "low",
        capacitySemantics: "immediate-bounded",
      },
    );

    expect(result.score).toBe(40);
    expect(result.detail).toContain("not used for Safety Score uplift");
  });

  it("does not let static redemption uplift liquidity during severe active depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 33, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 82,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 2_300_000,
        immediateCapacityRatio: 0.1,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        routeStatus: "open",
      },
      { activeDepegBps: 8332 },
    );

    expect(result.score).toBe(33);
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("lets live-direct permissionless immediate redemption uplift during severe active depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 33, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 90,
        routeFamily: "psm-swap",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.3,
        resolutionState: "resolved",
        modelConfidence: "high",
        capacitySemantics: "immediate-bounded",
        capacityConfidence: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        routeStatus: "open",
      },
      { activeDepegBps: 3000 },
    );

    expect(result.score).toBeGreaterThan(90);
    expect(result.detail).not.toContain("not used for Safety Score uplift");
  });

  it("does not let degraded routes uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "degraded",
      },
    );

    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently degraded");
  });

  it("does NOT exclude redemption at 2499 bps depeg (just below severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 60,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2499 },
    );
    expect(result.score).not.toBeNull();
    expect(result.detail).not.toContain("active severe depeg requires live-open redemption evidence");
  });

  it("excludes non-live-direct redemption at exactly 2500 bps depeg (severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 60,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("does NOT exclude strong live-direct redemption at exactly 2500 bps depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 88,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "high",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).not.toContain("active severe depeg requires live-open redemption evidence");
    expect(result.score).not.toBeNull();
  });

  it("excludes live-proxy redemption during severe depeg (not considered strong)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 82,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-proxy",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("excludes paused routes regardless of confidence", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "paused",
      },
    );
    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently paused");
  });

  it("excludes cohort-limited routes regardless of confidence", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "cohort-limited",
      },
    );
    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently cohort-limited");
  });

  it("keeps unknown route status eligible outside severe active depegs", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "unknown",
      },
    );

    expect(result.score).toBeGreaterThan(40);
  });

  it("does not let eventual-only redemption uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 25, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 87,
        routeFamily: "basket-redeem",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "eventual-only",
        routeStatus: "open",
      },
    );

    expect(result.score).toBe(25);
    expect(result.detail).toContain("not used for Safety Score uplift (eventual-only route)");
  });

  it("lets documented offchain issuer eventual redemption add only a DEX-gated primary-market bonus", () => {
    const result = scoreLiquidity(
      { liquidityScore: 63, concentrationHhi: 0.04, poolCount: 100, chainCount: 10 },
      {
        score: 65,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "eventual-only",
        capacityConfidence: "documented-bound",
        routeStatus: "open",
      },
    );

    expect(result.score).toBe(69);
    expect(result.detail).toContain("primary-market exit bonus only");
    expect(result.detail).toContain("eventual redeemability modeled; immediate buffer not separately quantified");
    expect(result.detail).not.toContain("not used for Safety Score uplift");
  });

  it("does not let documented offchain issuer eventual redemption replace missing DEX liquidity", () => {
    const result = scoreLiquidity(undefined, {
      score: 65,
      routeFamily: "offchain-issuer",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      resolutionState: "resolved",
      modelConfidence: "medium",
      capacitySemantics: "eventual-only",
      capacityConfidence: "documented-bound",
      routeStatus: "open",
    });

    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("primary-market route requires DEX liquidity floor");
  });

  it("does not let low-confidence offchain issuer eventual redemption add a primary-market bonus", () => {
    const result = scoreLiquidity(
      { liquidityScore: 63, concentrationHhi: 0.04, poolCount: 100, chainCount: 10 },
      {
        score: 65,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        resolutionState: "resolved",
        modelConfidence: "low",
        capacitySemantics: "eventual-only",
        capacityConfidence: "documented-bound",
        routeStatus: "open",
      },
    );

    expect(result.score).toBe(63);
    expect(result.detail).toContain("low confidence");
  });

  it("excludes documented offchain issuer eventual redemption during severe active depegs", () => {
    const result = scoreLiquidity(
      { liquidityScore: 63, concentrationHhi: 0.04, poolCount: 100, chainCount: 10 },
      {
        score: 65,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "eventual-only",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        routeStatus: "open",
      },
      { activeDepegBps: 2500 },
    );

    expect(result.score).toBe(63);
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("caps queue redemption uplift before blending with DEX liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 90,
        routeFamily: "queue-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        settlementModel: "queued",
        routeStatus: "open",
      },
    );

    // Queue cap: min(90, 70), then best-path blend with DEX 40 => 70 + 4.
    expect(result.score).toBe(74);
  });
});

describe("computeStressedGrades", () => {
  const makeDimension = (score: number | null) => ({
    grade: score !== null ? scoreToGrade(score) : ("NR" as const),
    score,
    detail: "test",
  });

  const makeCard = (overrides: Partial<ReportCard> & Pick<ReportCard, "id" | "name" | "symbol">): ReportCard => ({
    id: overrides.id,
    name: overrides.name,
    symbol: overrides.symbol,
    overallGrade: overrides.overallGrade ?? "B+",
    overallScore: overrides.overallScore ?? 80,
    baseScore: overrides.baseScore ?? 79.5,
    dimensions: overrides.dimensions ?? {
      pegStability: makeDimension(90),
      liquidity: makeDimension(80),
      resilience: makeDimension(75),
      decentralization: makeDimension(70),
      dependencyRisk: makeDimension(85),
    },
    ratedDimensions: overrides.ratedDimensions ?? 5,
    rawInputs: overrides.rawInputs ?? {
      pegScore: 90,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 80,
      effectiveExitScore: 80,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: 0.2,
      bluechipGrade: null,
      canBeBlacklisted: false,
      chainTier: "ethereum",
      deploymentModel: "single-chain",
      collateralQuality: "native",
      custodyModel: "onchain",
      governanceTier: "decentralized",
      governanceQuality: "dao-governance",
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
      dependencyFromLive: false,
    },
    isDefunct: overrides.isDefunct ?? false,
  });

  it("replaces directly overridden overall scores without mutating dimensions", () => {
    const base = makeCard({
      id: "base",
      name: "Base",
      symbol: "BASE",
      overallScore: 88,
      overallGrade: "A+",
    });

    const [result] = computeStressedGrades([base], new Map([["base", 42]]));

    expect(result.overallScore).toBe(42);
    expect(result.overallGrade).toBe(scoreToGrade(42));
    expect(result.dimensions).toEqual(base.dimensions);
    expect(result.baseScore).toBe(base.baseScore);
  });

  it("recomputes dependency risk and overall score through transitive dependents", () => {
    const upstream = makeCard({
      id: "usdc",
      name: "USD Coin",
      symbol: "USDC",
      overallScore: 92,
      overallGrade: "A+",
    });
    const dependent = makeCard({
      id: "wrapper",
      name: "Wrapper",
      symbol: "WRAP",
      overallScore: 78,
      overallGrade: "B+",
      dimensions: {
        pegStability: makeDimension(90),
        liquidity: makeDimension(80),
        resilience: makeDimension(75),
        decentralization: makeDimension(70),
        dependencyRisk: makeDimension(92),
      },
      rawInputs: {
        pegScore: 90,
        activeDepeg: false,
        activeDepegBps: null,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: 80,
        effectiveExitScore: 80,
        redemptionBackstopScore: null,
        redemptionRouteFamily: null,
        redemptionModelConfidence: null,
        redemptionUsedForLiquidity: false,
        redemptionImmediateCapacityUsd: null,
        redemptionImmediateCapacityRatio: null,
        concentrationHhi: 0.2,
        bluechipGrade: null,
        canBeBlacklisted: "possible",
        chainTier: "ethereum",
        deploymentModel: "single-chain",
        collateralQuality: "native",
        custodyModel: "onchain",
        governanceTier: "centralized-dependent",
        governanceQuality: "multisig",
        dependencies: [{ id: "usdc", weight: 0.6, type: "collateral" }],
        navToken: false,
        collateralFromLive: false,
        dependencyFromLive: false,
      },
    });
    const transitive = makeCard({
      id: "downstream",
      name: "Downstream",
      symbol: "DOWN",
      overallScore: 74,
      overallGrade: "B",
      rawInputs: {
        pegScore: 90,
        activeDepeg: false,
        activeDepegBps: null,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: 80,
        effectiveExitScore: 80,
        redemptionBackstopScore: null,
        redemptionRouteFamily: null,
        redemptionModelConfidence: null,
        redemptionUsedForLiquidity: false,
        redemptionImmediateCapacityUsd: null,
        redemptionImmediateCapacityRatio: null,
        concentrationHhi: 0.2,
        bluechipGrade: null,
        canBeBlacklisted: false,
        chainTier: "ethereum",
        deploymentModel: "single-chain",
        collateralQuality: "native",
        custodyModel: "onchain",
        governanceTier: "decentralized",
        governanceQuality: "dao-governance",
        dependencies: [{ id: "wrapper", weight: 0.5, type: "mechanism" }],
        navToken: false,
        collateralFromLive: false,
        dependencyFromLive: false,
      },
    });

    const [, stressedDependent, stressedTransitive] = computeStressedGrades(
      [upstream, dependent, transitive],
      new Map([["usdc", 40]]),
    );

    expect(stressedDependent.dimensions.dependencyRisk.score).toBe(44);
    expect(stressedDependent.dimensions.dependencyRisk.grade).toBe(scoreToGrade(44));
    expect(stressedDependent.overallScore).toBeLessThan(dependent.overallScore ?? 0);
    expect(stressedTransitive.dimensions.dependencyRisk.score).toBeLessThan(transitive.dimensions.dependencyRisk.score ?? 100);
    expect(stressedTransitive.overallScore).toBeLessThan(transitive.overallScore ?? 0);
  });

  it("caps tracked variants at the parent overall score in live and stressed paths", () => {
    const parent = makeCard({
      id: "parent",
      name: "Parent",
      symbol: "PAR",
      overallScore: 72,
      overallGrade: scoreToGrade(72),
    });
    const variant = makeCard({
      id: "variant",
      name: "Variant",
      symbol: "VAR",
      overallScore: 72,
      overallGrade: scoreToGrade(72),
      rawInputs: {
        ...createReportCardRawInputs({
          pegScore: 95,
          liquidityScore: 90,
          effectiveExitScore: 90,
          governanceTier: "centralized-dependent",
          governanceQuality: "wrapper",
          dependencies: [{ id: "parent", weight: 1, type: "wrapper" }],
          variantParentId: "parent",
          variantKind: "savings-passthrough",
        }),
      },
      dimensions: {
        pegStability: makeDimension(95),
        liquidity: makeDimension(90),
        resilience: makeDimension(88),
        decentralization: makeDimension(70),
        dependencyRisk: makeDimension(82),
      },
      baseScore: 86.5,
    });

    const [unchangedParent, stressedVariant] = computeStressedGrades(
      [parent, variant],
      new Map([["variant", 90]]),
    );

    expect(unchangedParent.overallScore).toBe(72);
    expect(stressedVariant.overallScore).toBe(72);
    expect(stressedVariant.overallCapped).toBe(true);
    expect(stressedVariant.uncappedOverallScore).toBe(90);
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
    const result = applyVariantOverallCap(
      { grade: "NR", score: null, baseScore: null, ratedDimensions: 0 },
      72,
    );
    expect(result.overallCapped).toBe(false);
    expect(result.score).toBeNull();
    expect(result.uncappedOverallScore).toBeNull();
  });
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

  it("returns possible when an explicit override marks the coin as mutable", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: "possible" as const,
    };
    expect(isBlacklistable(meta as never)).toBe("possible");
  });

  it("returns inherited for reserve exposure even when governance is centralized-dependent", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "Wrapped BTC", pct: 60, risk: "medium", blacklistable: true },
      ],
    };
    expect(isBlacklistable(meta as never, new Set(["usdc-circle"]))).toBe("inherited");
  });

  it("returns inherited for direct reserve exposure below the old inherited threshold", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "USDC buffer", pct: 35, risk: "low" },
        { name: "ETH", pct: 65, risk: "very-low" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited for cex-backed reserve rails even without explicit reserve annotations", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      custodyModel: "cex" as const,
      reserves: [
        { name: "Short perp margin (Copper/Ceffu off-exchange)", pct: 20, risk: "high" },
        { name: "JLP basket", pct: 80, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited when most reserves sit in named stablecoin baskets", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)", pct: 80, risk: "high" },
        { name: "Short perp margin", pct: 20, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited for majority reserves in stablecoin plus custodial wrapper collateral", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "FBTC (tokenized BTC via Cobo custody)", pct: 45, risk: "medium" },
        { name: "USDT (1:1 minted deposits)", pct: 40, risk: "low" },
        { name: "BTC LSTs", pct: 15, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited for majority reserves in custodied BTC wrappers and issuer-seizable tokenized collateral", () => {
    const meta = {
      flags: { governance: "decentralized" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "BOSS (Boss Info AG)", pct: 38, risk: "very-high" },
        { name: "cbBTC (Coinbase Wrapped BTC)", pct: 18, risk: "medium" },
        { name: "WBTC (Wrapped BTC)", pct: 15, risk: "medium" },
        { name: "ETH / wstETH", pct: 29, risk: "low" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns false for centralized-dependent governance without explicit, reserve, or custody risk", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "ETH", pct: 100, risk: "very-low" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });
});

describe("enrichLiveSlicesForBlacklist", () => {
  function metaStub(id: string, symbol: string) {
    return { id, symbol } as never;
  }

  const blacklistableIds = new Set(["usdc-circle", "usde-ethena", "crvusd-curve"]);
  const trackedMetaById = new Map([
    ["usdc-circle", metaStub("usdc-circle", "USDC")],
    ["usde-ethena", metaStub("usde-ethena", "USDe")],
    ["crvusd-curve", metaStub("crvusd-curve", "crvUSD")],
    ["xy-coin", metaStub("xy-coin", "XY")], // 2-char symbol, should be skipped
  ]);

  it("tags slice when name contains a blacklistable symbol", () => {
    const live = [{ name: "Stablecoin collateral (sUSDe, sUSDS, crvUSD)", pct: 96.6, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags slice when coinId points to blacklistable coin", () => {
    const live = [{ name: "stataUSDC GSM", pct: 25, risk: "low" as const, coinId: "usdc-circle" }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains direct stablecoin basket clues", () => {
    const live = [{ name: "JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)", pct: 80, risk: "high" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains a centralized-custody BTC wrapper symbol", () => {
    const live = [{ name: "cbBTC (Coinbase Wrapped BTC)", pct: 55, risk: "medium" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains an issuer-seizable tokenized security symbol", () => {
    const live = [{ name: "BOSS (Boss Info AG)", pct: 38, risk: "very-high" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("does not tag slice without blacklistable symbols", () => {
    const live = [{ name: "ETH / wstETH", pct: 34, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBeUndefined();
  });

  it("returns already-annotated slices unchanged", () => {
    const live = [{ name: "Some reserves", pct: 50, risk: "low" as const, blacklistable: true }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0]).toBe(live[0]); // same reference, no copy
  });

  it("skips symbols shorter than 3 characters", () => {
    const idsWithShort = new Set([...blacklistableIds, "xy-coin"]);
    const live = [{ name: "XY token pool", pct: 80, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, idsWithShort, trackedMetaById);
    expect(result[0].blacklistable).toBeUndefined();
  });

  it("enables inherited detection when combined with isBlacklistable", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [{ name: "sUSDe", pct: 15, risk: "medium", coinId: "usde-ethena" }],
    };
    const live = [
      { name: "Stablecoin collateral (sUSDe, sUSDS, crvUSD)", pct: 96.6, risk: "low" as const },
      { name: "ETH / Liquid staking", pct: 3.4, risk: "low" as const },
    ];
    const enriched = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(isBlacklistable(meta as never, blacklistableIds, enriched)).toBe("inherited");
  });
});

describe("resolveBlacklistStatuses variant inheritance", () => {
  it("inherits a blacklistable parent as upstream on a tracked variant", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized" as const },
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe(true);
    expect(resolved.get("child")).toBe("inherited");
  });

  it("propagates a possible parent status to a tracked variant", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized-dependent" as const },
        canBeBlacklisted: "possible" as const,
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe("possible");
    expect(resolved.get("child")).toBe("possible");
  });

  it("does not coerce a variant to inherited when the parent is not blacklistable", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "decentralized" as const },
        canBeBlacklisted: false as const,
        reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
        reserves: [{ name: "Parent", pct: 100, risk: "low" as const, coinId: "parent" }],
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe(false);
    expect(resolved.get("child")).toBe(false);
  });

  it("keeps an explicit override on the variant even when the parent is blacklistable", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized" as const },
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "risk-absorption" as const,
        pegReferenceId: "parent",
        canBeBlacklisted: true as const,
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("child")).toBe(true);
  });
});

describe("resolveBlacklistStatuses", () => {
  it("resolves cyclic inherited exposure to a fixed point", () => {
    const metas = [
      {
        id: "a",
        name: "A",
        symbol: "A",
        flags: { governance: "decentralized" as const },
        reserves: [
          { name: "USDC", pct: 60, risk: "low" as const },
          { name: "B", pct: 40, risk: "low" as const, coinId: "b" },
        ],
      },
      {
        id: "b",
        name: "B",
        symbol: "B",
        flags: { governance: "decentralized" as const },
        reserves: [
          { name: "A", pct: 80, risk: "low" as const, coinId: "a" },
          { name: "ETH", pct: 20, risk: "very-low" as const },
        ],
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);

    expect(resolved.get("a")).toBe("inherited");
    expect(resolved.get("b")).toBe("inherited");
  });
});

describe("getBlacklistStatusLabel", () => {
  it("formats inherited as Upstream", () => {
    expect(getBlacklistStatusLabel("inherited")).toBe("Upstream");
  });

  it("formats explicit false as No", () => {
    expect(getBlacklistStatusLabel(false)).toBe("No");
  });
});
