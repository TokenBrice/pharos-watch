import { describe, it, expect } from "vitest";
import {
  scoreLiquidity,
  scoreToGrade,
  computeOverallGrade,
  computeStressedGrades,
  scoreDependencyRisk,
  scoreResilience,
  scoreDecentralization,
  chainInfraScore,
  isBlacklistable,
  enrichLiveSlicesForBlacklist,
  GRADE_THRESHOLDS,
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

  it("caps and discounts redemption-only scoring correctly", () => {
    const result = scoreLiquidity(undefined, {
      score: 90,
      routeFamily: "collateral-redeem",
      immediateCapacityUsd: 100_000_000,
      immediateCapacityRatio: 1.0,
      resolutionState: "resolved",
      modelConfidence: "medium",
      capacitySemantics: "immediate-bounded",
    });

    // min(70, 90 * 0.75) = min(70, 67.5) = 68
    expect(result.score).toBe(68);
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

    expect(result.score).toBe(95);
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
    },
    dependencies: overrides.dependencies,
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

  it("recomputes dependency risk and overall score for direct dependents only", () => {
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
      },
    });

    const [, stressedDependent, stressedTransitive] = computeStressedGrades(
      [upstream, dependent, transitive],
      new Map([["usdc", 40]]),
    );

    expect(stressedDependent.dimensions.dependencyRisk.score).toBe(44);
    expect(stressedDependent.dimensions.dependencyRisk.grade).toBe(scoreToGrade(44));
    expect(stressedDependent.overallScore).toBeLessThan(dependent.overallScore ?? 0);
    expect(stressedTransitive).toEqual(transitive);
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

  it("returns inherited for majority reserve exposure even when governance is centralized-dependent", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "Wrapped BTC", pct: 60, risk: "medium", blacklistable: true },
      ],
    };
    expect(isBlacklistable(meta as never, new Set(["usdc-circle"]))).toBe("inherited");
  });

  it("returns false for centralized-dependent governance without explicit or inherited risk", () => {
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
