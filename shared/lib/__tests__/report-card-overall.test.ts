import { describe, it, expect } from "vitest";
import { createReportCardRawInputs } from "../report-card-raw-inputs";
import { scoreToGrade, computeStressedGrades } from "../report-cards";
import type { ReportCard } from "../../types/report-cards";

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
    expect(stressedTransitive.dimensions.dependencyRisk.score).toBeLessThan(
      transitive.dimensions.dependencyRisk.score ?? 100,
    );
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

    const [unchangedParent, stressedVariant] = computeStressedGrades([parent, variant], new Map([["variant", 90]]));

    expect(unchangedParent.overallScore).toBe(72);
    expect(stressedVariant.overallScore).toBe(72);
    expect(stressedVariant.overallCapped).toBe(true);
    expect(stressedVariant.uncappedOverallScore).toBe(90);
  });
});
