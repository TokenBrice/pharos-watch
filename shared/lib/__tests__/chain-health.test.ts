import { describe, it, expect } from "vitest";
import {
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeChainEnvironmentAssessment,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
  CHAIN_ENVIRONMENT_SCORES,
} from "../chain-health";
import {
  computeL2BeatChainEnvironmentScore,
  computeL2BeatRiskScore,
  getL2BeatChainEnvironmentAssessment,
  resolveL2BeatProjectId,
  type L2BeatChainRiskSnapshot,
  type L2BeatRiskSentiment,
  type L2BeatStage,
} from "../chains/l2beat-risk";

function l2beatSnapshotFixture(input: {
  stage?: L2BeatStage;
  sentiments?: L2BeatRiskSentiment[];
} = {}): L2BeatChainRiskSnapshot {
  const sentiments = input.sentiments ?? ["neutral", "neutral", "neutral", "neutral", "neutral"];
  const [sequencerFailure, stateValidation, dataAvailability, exitWindow, proposerFailure] = sentiments;
  return {
    slug: "fixture",
    name: "Fixture",
    type: "layer2",
    category: "Other",
    hostChain: "Ethereum",
    stage: input.stage ?? "Stage 1",
    isUnderReview: input.stage === "Under review",
    risks: {
      sequencerFailure: { value: "fixture", sentiment: sequencerFailure! },
      stateValidation: { value: "fixture", sentiment: stateValidation! },
      dataAvailability: { value: "fixture", sentiment: dataAvailability! },
      exitWindow: { value: "fixture", sentiment: exitWindow! },
      proposerFailure: { value: "fixture", sentiment: proposerFailure! },
    },
  };
}

describe("computeConcentrationScore", () => {
  it("returns 0 for a single-stablecoin chain", () => {
    expect(computeConcentrationScore([1.0])).toBe(0);
  });

  it("returns ~50 for an even two-coin split", () => {
    const score = computeConcentrationScore([0.5, 0.5]);
    expect(score).toBe(50);
  });

  it("returns high score for evenly distributed coins", () => {
    const shares = [0.25, 0.25, 0.25, 0.25];
    expect(computeConcentrationScore(shares)).toBe(75);
  });

  it("returns 0 for empty array", () => {
    expect(computeConcentrationScore([])).toBe(0);
  });
});

describe("computeBackingDiversityScore", () => {
  it("returns 0 for monoculture (all one type)", () => {
    const distribution = { "rwa-backed": 1, "crypto-backed": 0 };
    expect(computeBackingDiversityScore(distribution)).toBe(0);
  });

  it("returns 100 for an even RWA/crypto split", () => {
    const distribution = { "rwa-backed": 0.5, "crypto-backed": 0.5 };
    expect(computeBackingDiversityScore(distribution)).toBe(100);
  });

  it("returns intermediate score for an imbalanced split", () => {
    const distribution = { "rwa-backed": 0.75, "crypto-backed": 0.25 };
    expect(computeBackingDiversityScore(distribution)).toBe(81);
  });

  it("ignores legacy algorithmic weight and renormalizes the active cohorts", () => {
    const distribution = { "rwa-backed": 0.25, "crypto-backed": 0.25, algorithmic: 0.5 };
    expect(computeBackingDiversityScore(distribution)).toBe(100);
  });
});

describe("computePegStabilityScore", () => {
  it("returns 100 for perfect peg", () => {
    const coins = [{ price: 1.0, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(100);
  });

  it("returns 0 when deviation exceeds 500 bps", () => {
    const coins = [{ price: 0.94, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(0);
  });

  it("returns 50 for no-price coins", () => {
    const coins = [{ price: null as number | null, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(50);
  });

  it("supply-weights multiple coins", () => {
    const coins = [
      { price: 1.0, pegRef: 1.0, supplyUsd: 900_000 },
      { price: 0.97, pegRef: 1.0, supplyUsd: 100_000 },
    ];
    const score = computePegStabilityScore(coins);
    // 90% weight at 100, 10% weight at 40 => 94
    expect(score).toBe(94);
  });
});

describe("computeQualityScore", () => {
  it("returns supply-weighted average", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 500_000 },
      { safetyScore: 60, supplyUsd: 500_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBe(70);
  });

  it("returns null when coverage is below threshold", () => {
    const coins = [
      { safetyScore: null as number | null, supplyUsd: 600_000 },
      { safetyScore: 80, supplyUsd: 400_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBeNull();
  });

  it("excludes unrated supply and renormalizes over rated supply", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 800_000 },
      { safetyScore: null as number | null, supplyUsd: 200_000 },
    ];
    const score = computeQualityScore(coins, 0.5);
    // Unrated supply is dropped from numerator and denominator => 80, not an imputed blend.
    expect(score).toBe(80);
  });

  it("keeps the coverage gate as the only not-rated signal", () => {
    const coins = [
      { safetyScore: 90, supplyUsd: 499_000 },
      { safetyScore: null as number | null, supplyUsd: 501_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBeNull();
  });
});

describe("computeChainEnvironmentAssessment", () => {
  it("returns 100 for tier 1", () => {
    expect(computeChainEnvironmentAssessment(1).score).toBe(100);
  });

  it("returns 60 for tier 2", () => {
    expect(computeChainEnvironmentAssessment(2).score).toBe(60);
  });

  it("returns 20 for tier 3", () => {
    expect(computeChainEnvironmentAssessment(3).score).toBe(20);
  });

  it("uses L2BEAT chain-risk scoring for matched chains", () => {
    const assessment = getL2BeatChainEnvironmentAssessment("base");

    expect(assessment).toMatchObject({
      projectId: "base",
      stage: "Stage 1",
      riskScore: 84,
      score: 82,
    });
    expect(computeChainEnvironmentAssessment(2, "base").score).toBe(82);
  });

  it("falls back to resilience tier scoring for unmatched chains", () => {
    expect(getL2BeatChainEnvironmentAssessment("stable")).toBeNull();
    expect(computeChainEnvironmentAssessment(3, "stable").score).toBe(20);
  });

  it("resolves explicit Pharos to L2BEAT aliases", () => {
    expect(resolveL2BeatProjectId("zksync")).toBe("zksync2");
    expect(resolveL2BeatProjectId("polygon-zkevm")).toBe("polygonzkevm");
    expect(resolveL2BeatProjectId("morph-l2")).toBe("morph");
  });
});

describe("L2BEAT risk scoring", () => {
  it("scores all-good, all-bad, and mixed risk sentiment snapshots", () => {
    expect(computeL2BeatRiskScore(l2beatSnapshotFixture({
      sentiments: ["good", "good", "good", "good", "good"],
    }))).toBe(100);
    expect(computeL2BeatRiskScore(l2beatSnapshotFixture({
      sentiments: ["bad", "bad", "bad", "bad", "bad"],
    }))).toBe(20);
    expect(computeL2BeatRiskScore(l2beatSnapshotFixture({
      sentiments: ["good", "warning", "bad", "UnderReview", "neutral"],
    }))).toBe(56);
  });

  it("keeps UnderReview and neutral sentiments score-neutral for forward compatibility", () => {
    expect(computeL2BeatRiskScore(l2beatSnapshotFixture({
      sentiments: ["UnderReview", "neutral", "UnderReview", "neutral", "UnderReview"],
    }))).toBe(50);
  });
});

describe("computeL2BeatChainEnvironmentScore", () => {
  it("pins stage tier scores with neutral risk sentiment", () => {
    expect(computeL2BeatChainEnvironmentScore(l2beatSnapshotFixture({ stage: "Stage 2" }))).toBe(70);
    expect(computeL2BeatChainEnvironmentScore(l2beatSnapshotFixture({ stage: "Stage 1" }))).toBe(62);
    expect(computeL2BeatChainEnvironmentScore(l2beatSnapshotFixture({ stage: "Stage 0" }))).toBe(52);
    expect(computeL2BeatChainEnvironmentScore(l2beatSnapshotFixture({ stage: "Not applicable" }))).toBe(50);
    expect(computeL2BeatChainEnvironmentScore(l2beatSnapshotFixture({ stage: "Under review" }))).toBe(50);
  });
});

describe("computeHealthScore", () => {
  it("computes weighted composite", () => {
    const score = computeHealthScore({
      quality: 80,
      chainEnvironment: 60,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    });
    // 0.30*80 + 0.20*60 + 0.20*60 + 0.20*90 + 0.10*40 = 24+12+12+18+4 = 70
    expect(score).toBe(70);
  });

  it("returns null when quality is null", () => {
    expect(computeHealthScore({
      quality: null,
      chainEnvironment: 60,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    })).toBeNull();
  });

  it("tier 1 chains score higher than tier 3", () => {
    const base = { quality: 70, concentration: 50, pegStability: 90, backingDiversity: 30 };
    const tier1Score = computeHealthScore({ ...base, chainEnvironment: CHAIN_ENVIRONMENT_SCORES[1] })!;
    const tier3Score = computeHealthScore({ ...base, chainEnvironment: CHAIN_ENVIRONMENT_SCORES[3] })!;
    expect(tier1Score).toBeGreaterThan(tier3Score);
    // 20% weight * (100 - 20) = 16 point difference
    expect(tier1Score - tier3Score).toBe(16);
  });
});

describe("getHealthBand", () => {
  it("maps score ranges correctly", () => {
    expect(getHealthBand(100)).toBe("robust");
    expect(getHealthBand(80)).toBe("robust");
    expect(getHealthBand(79)).toBe("healthy");
    expect(getHealthBand(85)).toBe("robust");
    expect(getHealthBand(60)).toBe("healthy");
    expect(getHealthBand(59)).toBe("mixed");
    expect(getHealthBand(65)).toBe("healthy");
    expect(getHealthBand(40)).toBe("mixed");
    expect(getHealthBand(39)).toBe("fragile");
    expect(getHealthBand(45)).toBe("mixed");
    expect(getHealthBand(20)).toBe("fragile");
    expect(getHealthBand(19)).toBe("concentrated");
    expect(getHealthBand(25)).toBe("fragile");
    expect(getHealthBand(10)).toBe("concentrated");
    expect(getHealthBand(null)).toBeNull();
  });
});

describe("HEALTH_METHODOLOGY_VERSION", () => {
  it("is a semver-like string", () => {
    expect(HEALTH_METHODOLOGY_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
