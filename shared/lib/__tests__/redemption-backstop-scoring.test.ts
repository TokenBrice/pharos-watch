import { describe, it, expect } from "vitest";
import {
  applyCapacityConstraintScoreEffects,
  classifyExitRouteCorrelation,
  computeEffectiveExitScore,
  computeEffectiveExitScoreDiagnostics,
  computeCapacityScore,
  computeModeledExitSizeUsd,
  computeRedemptionBackstopScore,
  evaluateExitRouteObservationEligibility,
  isStrongLiveDirectRoute,
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
  SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY,
} from "../redemption-backstop-scoring";
import type { ExitRouteObservation } from "../../types/market";
import { DexExitRouteObservationSchema, RedemptionExitRouteObservationSchema } from "../../types/exit-route";
import { RedemptionCapacityProfileSchema } from "../../types/redemption";

function exitRoute(overrides: Partial<ExitRouteObservation> = {}): ExitRouteObservation {
  return {
    routeId: "route:test",
    routeFamily: "protocol-redemption",
    scope: { kind: "protocol", protocol: "test-protocol", chain: "ethereum" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
    evidenceKind: "onchain-contract-state",
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_000,
    freshnessSeconds: 0,
    commonModeKeys: ["chain:ethereum", "protocol:test-protocol"],
    ...overrides,
  };
}

describe("computeEffectiveExitScore", () => {
  it("returns null when both inputs are null", () => {
    expect(computeEffectiveExitScore(null, null)).toBeNull();
  });

  it("returns liquidity score when only liquidity available", () => {
    expect(computeEffectiveExitScore(80, null)).toBe(80);
    expect(computeEffectiveExitScore(0, null)).toBe(0);
  });

  it("returns redemption score directly when only redemption available (no cap)", () => {
    expect(computeEffectiveExitScore(null, 90)).toBe(90);
    expect(computeEffectiveExitScore(null, 100)).toBe(100);
    expect(computeEffectiveExitScore(null, 40)).toBe(40);
    // Route family caps (65/70) are applied upstream, not here
    expect(computeEffectiveExitScore(null, 70)).toBe(70);
  });

  it("uses best path + diversification bonus when both exist", () => {
    // dex=80, redemption=60 → best=80, bonus=60*0.10=6 → 86
    expect(computeEffectiveExitScore(80, 60)).toBe(86);
    // dex=40, redemption=90 → best=90, bonus=40*0.10=4 → 94
    expect(computeEffectiveExitScore(40, 90)).toBe(94);
    // dex=51, redemption=90 → best=90, bonus=51*0.10=5.1 → 95
    expect(computeEffectiveExitScore(51, 90)).toBe(95);
  });

  it("preserves legacy diversification without options but requires independent correlation with v4 options", () => {
    expect(computeEffectiveExitScore(40, 90)).toBe(94);
    expect(
      computeEffectiveExitScore(40, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: 25_000_000,
        modelConfidence: "high",
      }),
    ).toBe(90);
  });

  it("caps effective score at 100", () => {
    // dex=95, redemption=98 → best=98, bonus=95*0.10=9.5 → 107.5 → capped at 100
    expect(computeEffectiveExitScore(95, 98)).toBe(100);
    expect(computeEffectiveExitScore(100, 100)).toBe(100);
  });

  it("is monotonic — adding any path never lowers the score", () => {
    // Strong redemption, adding weak DEX should only help
    const redeemOnly = computeEffectiveExitScore(null, 80)!;
    const withWeakDex = computeEffectiveExitScore(15, 80)!;
    expect(withWeakDex).toBeGreaterThanOrEqual(redeemOnly);

    // Strong DEX, adding weak redemption should only help
    const dexOnly = computeEffectiveExitScore(70, null)!;
    const withWeakRedeem = computeEffectiveExitScore(70, 20)!;
    expect(withWeakRedeem).toBeGreaterThanOrEqual(dexOnly);
  });

  it("clamps inputs to 0-100", () => {
    expect(computeEffectiveExitScore(150, null)).toBe(100);
    expect(computeEffectiveExitScore(-10, null)).toBe(0);
  });

  it("handles non-finite inputs as null", () => {
    expect(computeEffectiveExitScore(NaN, null)).toBeNull();
    expect(computeEffectiveExitScore(null, Infinity)).toBeNull();
    expect(computeEffectiveExitScore(undefined, undefined)).toBeNull();
  });

  it("scales redemption contribution by executable capacity and confidence", () => {
    expect(
      computeEffectiveExitScore(40, 90, {
        circulatingSupplyUsd: 1_000_000_000,
        currentExecutableCapacityUsd: 1_000_000,
        routeExitCorrelation: "unknown",
        modelConfidence: "medium",
      }),
    ).toBe(40);
  });

  it("applies diversification bonus only for independent issuer rails", () => {
    const sharedBacking = computeEffectiveExitScore(70, 80, {
      circulatingSupplyUsd: 100_000_000,
      currentExecutableCapacityUsd: 25_000_000,
      routeExitCorrelation: "same-stablecoin-pool-backing",
      modelConfidence: "high",
    });
    const independent = computeEffectiveExitScore(70, 80, {
      circulatingSupplyUsd: 100_000_000,
      currentExecutableCapacityUsd: 25_000_000,
      routeExitCorrelation: "independent-issuer-rail",
      modelConfidence: "high",
    });

    expect(sharedBacking).toBe(80);
    expect(independent).toBe(87);
  });

  it("models exit size as five percent of supply with floor and cap", () => {
    expect(computeModeledExitSizeUsd(1_000_000)).toBe(100_000);
    expect(computeModeledExitSizeUsd(100_000_000)).toBe(5_000_000);
    expect(computeModeledExitSizeUsd(10_000_000_000)).toBe(25_000_000);
  });

  it("returns null modeled exit size for missing, non-finite, or non-positive supply", () => {
    expect(computeModeledExitSizeUsd(null)).toBeNull();
    expect(computeModeledExitSizeUsd(0)).toBeNull();
    expect(computeModeledExitSizeUsd(-1)).toBeNull();
    expect(computeModeledExitSizeUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("defaults missing model confidence to the low factor when v4 options are present", () => {
    // Full capacity, no modelConfidence → redemption discounted by the low factor: 90 * 0.35 → 31
    expect(
      computeEffectiveExitScore(null, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: 25_000_000,
      }),
    ).toBe(31);
    // Identical to passing explicit low confidence
    expect(
      computeEffectiveExitScore(null, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: 25_000_000,
        modelConfidence: "low",
      }),
    ).toBe(31);
    // Best-path: discounted redemption (31) loses to DEX (40), no bonus without independent correlation
    expect(
      computeEffectiveExitScore(40, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: 25_000_000,
      }),
    ).toBe(40);
    // Legacy two-arg call (no v4 options) keeps full passthrough — the blend is not applied at all
    expect(computeEffectiveExitScore(null, 90)).toBe(90);
  });

  it("treats invalid executable capacity as unbounded and clamps negative executable capacity to zero", () => {
    expect(
      computeEffectiveExitScore(null, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: Number.NaN,
        modelConfidence: "high",
      }),
    ).toBe(90);
    expect(
      computeEffectiveExitScore(null, 90, {
        modeledExitSizeUsd: 25_000_000,
        currentExecutableCapacityUsd: -1,
        modelConfidence: "high",
      }),
    ).toBe(0);
  });

  it("exports the effective-exit model parameters used by scoring and cron metadata", () => {
    expect(REDEMPTION_EFFECTIVE_EXIT_MODEL).toMatchObject({
      model: "best-path",
      diversificationFactor: 0.1,
      modeledExitSize: {
        supplyRatio: 0.05,
        floorUsd: 100_000,
        capUsd: 25_000_000,
      },
      confidenceFactors: {
        high: 1,
        medium: 0.75,
        low: 0.35,
      },
    });
  });

  it("keeps same-notional observations shadow-only unless explicitly activated", () => {
    const dex = exitRoute({
      routeId: "dex:thin",
      routeFamily: "dex-amm",
      executableUsd: 100_000,
      completionRatio: 0.1,
      evidenceKind: "measured-executable-depth",
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    expect(
      computeEffectiveExitScore(80, null, {
        modeledExitSizeUsd: 1_000_000,
        dexExitRouteObservations: [dex],
        exitObservationAsOfSec: 1_100,
        dexExitObservationMaxAgeSec: 1_000,
      }),
    ).toBe(80);
  });

  it("fails closed in explicit active mode instead of restoring legacy values", () => {
    expect(computeEffectiveExitScoreDiagnostics(80, 90, { sameNotionalScoringMode: "active" })).toMatchObject({
      score: null,
      scoringMode: "active",
      correlationReason: "missing-modeled-exit-size",
    });
    expect(
      computeEffectiveExitScoreDiagnostics(80, 90, {
        sameNotionalScoringMode: "active",
        modeledExitSizeUsd: 1_000_000,
      }),
    ).toMatchObject({
      score: null,
      scoringMode: "active",
      correlationReason: "missing-observation-clock",
    });
    expect(
      computeEffectiveExitScoreDiagnostics(80, 90, {
        sameNotionalScoringMode: "active",
        modeledExitSizeUsd: 1_000_000,
        exitObservationAsOfSec: 1_000,
      }),
    ).toMatchObject({
      score: null,
      scoringMode: "active",
      correlationReason: "no-route-observations",
    });
  });

  it("lets a strong same-notional redemption route carry thin DEX capacity", () => {
    const dex = exitRoute({
      routeId: "dex:thin",
      routeFamily: "dex-amm",
      executableUsd: 100_000,
      completionRatio: 0.1,
      evidenceKind: "measured-executable-depth",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    const redemption = exitRoute({
      routeId: "redeem:strong",
      output: { kind: "fiat", currency: "USD" },
      commonModeKeys: ["issuer:example", "custodian:example-bank"],
    });
    const result = computeEffectiveExitScoreDiagnostics(80, 90, {
      modeledExitSizeUsd: 1_000_000,
      dexExitRouteObservations: [dex],
      redemptionExitRouteObservations: [redemption],
      routeExitCorrelation: "independent-issuer-rail",
      modelConfidence: "high",
      sameNotionalScoringMode: "active",
      exitObservationAsOfSec: 1_100,
      dexExitObservationMaxAgeSec: 1_000,
      liveRedemptionExitObservationMaxAgeSec: 1_000,
    });

    expect(result.score).toBe(91);
    expect(result.dexRouteScore).toBe(8);
    expect(result.redemptionRouteScore).toBe(90);
    expect(result.diversificationBonusApplied).toBe(true);
  });

  it("preserves the aggregate DEX floor only for partial populated coverage", () => {
    const redemption = exitRoute({
      routeId: "redeem:only",
      executableUsd: 500_000,
      completionRatio: 0.5,
      output: { kind: "fiat", currency: "USD" },
      commonModeKeys: ["issuer:example"],
    });
    const sharedOptions = {
      modeledExitSizeUsd: 1_000_000,
      redemptionExitRouteObservations: [redemption],
      sameNotionalScoringMode: "active" as const,
      exitObservationAsOfSec: 1_100,
      liveRedemptionExitObservationMaxAgeSec: 1_000,
      modelConfidence: "high" as const,
      dexExitRouteCoverageComplete: false,
    };

    expect(
      computeEffectiveExitScoreDiagnostics(80, 40, {
        ...sharedOptions,
        dexExitRouteCoverageStatus: "populated",
        dexExitRouteRetainedPoolCount: 2,
      }),
    ).toMatchObject({ score: 80, correlationReason: "incomplete-dex-route-coverage-legacy-floor" });
    expect(
      computeEffectiveExitScoreDiagnostics(80, 40, {
        ...sharedOptions,
        dexExitRouteCoverageStatus: "unknown",
        dexExitRouteRetainedPoolCount: 0,
      }),
    ).toMatchObject({ score: 20, dexRouteScore: null, correlationReason: "single-observed-route" });
  });

  it("does not let a weaker optional route lower the strong route", () => {
    const dex = exitRoute({
      routeId: "dex:strong",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    const weakRedemption = exitRoute({
      routeId: "redeem:weak",
      executableUsd: 100_000,
      completionRatio: 0.1,
      output: { kind: "fiat", currency: "USD" },
      commonModeKeys: ["issuer:example"],
    });
    const options = {
      modeledExitSizeUsd: 1_000_000,
      dexExitRouteObservations: [dex],
      sameNotionalScoringMode: "active" as const,
      exitObservationAsOfSec: 1_100,
      dexExitObservationMaxAgeSec: 1_000,
      liveRedemptionExitObservationMaxAgeSec: 1_000,
      modelConfidence: "high" as const,
    };

    const dexOnly = computeEffectiveExitScore(80, null, options)!;
    const withWeakRedemption = computeEffectiveExitScore(80, 20, {
      ...options,
      redemptionExitRouteObservations: [weakRedemption],
    })!;
    expect(withWeakRedemption).toBeGreaterThanOrEqual(dexOnly);
  });

  it("uses conservative curve lower bounds for arbitrary modeled notionals", () => {
    const dex = exitRoute({
      routeId: "dex:grid",
      routeFamily: "dex-orderbook",
      evidenceKind: "direct-orderbook-depth",
      requestedNotionalUsd: 1_000_000,
      executableUsd: 1_000_000,
      completionRatio: 1,
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1 },
        { requestedNotionalUsd: 10_000_000, maxCostBps: 200, executableUsd: 2_000_000, completionRatio: 0.2 },
      ],
    });
    const result = computeEffectiveExitScoreDiagnostics(80, null, {
      modeledExitSizeUsd: 5_000_000,
      dexExitRouteObservations: [dex],
      sameNotionalScoringMode: "active",
      exitObservationAsOfSec: 1_100,
      dexExitObservationMaxAgeSec: 1_000,
    });

    expect(result.score).toBe(16);
  });

  it("fails active scoring closed when every observation is diagnostic-only or stale", () => {
    const diagnostic = exitRoute({
      routeId: "dex:diagnostic",
      routeFamily: "dex-orderbook",
      evidenceKind: "direct-orderbook-depth",
      scoreEligible: false,
    });
    const stale = exitRoute({
      routeId: "dex:stale",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      observedAt: 100,
    });
    expect(
      computeEffectiveExitScoreDiagnostics(80, null, {
        modeledExitSizeUsd: 1_000_000,
        dexExitRouteObservations: [diagnostic, stale],
        sameNotionalScoringMode: "active",
        exitObservationAsOfSec: 2_000,
        dexExitObservationMaxAgeSec: 500,
      }),
    ).toMatchObject({
      score: null,
      scoringMode: "active",
      dexRouteScore: null,
      correlationReason: "no-eligible-route-observations",
    });
  });

  it("uses separate live producer ages and rejects future observations", () => {
    const dex = exitRoute({
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      observedAt: 900,
    });
    const redemption = exitRoute({ observedAt: 700 });
    const options = {
      exitObservationAsOfSec: 1_000,
      dexExitObservationMaxAgeSec: 60,
      liveRedemptionExitObservationMaxAgeSec: 400,
    };

    expect(evaluateExitRouteObservationEligibility(dex, "dex", options)).toBe("stale-observation");
    expect(evaluateExitRouteObservationEligibility(redemption, "redemption", options)).toBe("eligible");
    expect(evaluateExitRouteObservationEligibility({ ...dex, observedAt: 1_001 }, "dex", options)).toBe(
      "future-observation",
    );
  });

  it("uses the reviewed-terms horizon instead of the live producer freshness window", () => {
    const asOfSec = 40_000_000;
    const dex = exitRoute({
      routeId: "dex:fresh",
      routeFamily: "dex-amm",
      evidenceKind: "reserve-based-amm-simulation",
      observedAt: asOfSec - 60,
      commonModeKeys: ["protocol:dex"],
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
    });
    const reviewed = exitRoute({
      routeId: "redeem:reviewed",
      evidenceKind: "documented-terms",
      observedAt: asOfSec - 300 * 86_400,
      freshnessSeconds: 300 * 86_400,
      commonModeKeys: ["issuer:example"],
      output: { kind: "fiat", currency: "USD" },
    });
    const options = {
      modeledExitSizeUsd: 1_000_000,
      dexExitRouteObservations: [dex],
      sameNotionalScoringMode: "active" as const,
      exitObservationAsOfSec: asOfSec,
      dexExitObservationMaxAgeSec: 3_600,
      liveRedemptionExitObservationMaxAgeSec: 3_600,
      modelConfidence: "high" as const,
    };

    expect(
      computeEffectiveExitScoreDiagnostics(80, 70, {
        ...options,
        redemptionExitRouteObservations: [reviewed],
      }).comparedRouteIds,
    ).toEqual({ dex: "dex:fresh", redemption: "redeem:reviewed" });
    expect(
      computeEffectiveExitScoreDiagnostics(80, 70, {
        ...options,
        redemptionExitRouteObservations: [
          {
            ...reviewed,
            observedAt: asOfSec - SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec - 1,
            freshnessSeconds: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec + 1,
          },
        ],
      }).comparedRouteIds,
    ).toBeNull();
  });

  it("suppresses independence for shared domains, outputs, impairment, and unresolved outputs", () => {
    const dex = exitRoute({
      routeId: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    expect(
      classifyExitRouteCorrelation(
        dex,
        exitRoute({ routeId: "redeem", commonModeKeys: ["chain:ethereum", "issuer:example"] }),
      ).independent,
    ).toBe(false);
    expect(
      classifyExitRouteCorrelation(dex, exitRoute({ routeId: "redeem", commonModeKeys: ["issuer:example"] })).reason,
    ).toContain("shared-output");
    expect(
      classifyExitRouteCorrelation(
        dex,
        exitRoute({
          routeId: "redeem",
          output: { kind: "fiat", currency: "USD" },
          commonModeKeys: ["issuer:example"],
        }),
        undefined,
        ["usdc-circle"],
      ).reason,
    ).toContain("impaired-output");
    expect(
      classifyExitRouteCorrelation(
        dex,
        exitRoute({
          routeId: "redeem",
          output: { kind: "unresolved-basket" },
          commonModeKeys: ["issuer:example"],
        }),
        "independent-issuer-rail",
      ).independent,
    ).toBe(false);

    const collateralKey = "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const keyedDex = exitRoute({
      routeId: "dex:keyed",
      output: { kind: "unresolved-asset", assetKeys: [collateralKey] },
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    expect(
      classifyExitRouteCorrelation(
        keyedDex,
        exitRoute({
          routeId: "redeem:keyed",
          output: { kind: "collateral", assetKeys: [collateralKey] },
          commonModeKeys: ["issuer:example"],
        }),
      ).reason,
    ).toContain("shared-output");
    expect(
      classifyExitRouteCorrelation(
        keyedDex,
        exitRoute({
          routeId: "redeem:other",
          output: { kind: "fiat", currency: "USD" },
          commonModeKeys: ["issuer:example"],
        }),
        undefined,
        [collateralKey],
      ).reason,
    ).toContain("impaired-output");
  });

  it("treats curated non-independent correlation as a veto and independent as structural permission", () => {
    const dex = exitRoute({
      routeId: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      commonModeKeys: ["chain:ethereum", "protocol:dex"],
    });
    const redemption = exitRoute({
      routeId: "redemption",
      output: { kind: "fiat", currency: "USD" },
      commonModeKeys: ["issuer:example"],
    });

    expect(classifyExitRouteCorrelation(dex, redemption, "unknown")).toEqual({
      independent: false,
      reason: "curated-correlation-veto:unknown",
    });
    expect(classifyExitRouteCorrelation(dex, redemption)).toEqual({
      independent: false,
      reason: "missing-curated-correlation",
    });
    expect(classifyExitRouteCorrelation(dex, redemption, "independent-issuer-rail").independent).toBe(true);
    expect(
      classifyExitRouteCorrelation(
        dex,
        { ...redemption, commonModeKeys: ["chain:ethereum", "issuer:example"] },
        "independent-issuer-rail",
      ).independent,
    ).toBe(false);
  });

  it("reports the matching winning pair and resolves score ties by route-id tuple", () => {
    const highCorrelatedDex = exitRoute({
      routeId: "dex:high",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      executableUsd: 1_000_000,
      completionRatio: 1,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      commonModeKeys: ["issuer:example"],
    });
    const lowerIndependentDexZ = exitRoute({
      ...highCorrelatedDex,
      routeId: "dex:z",
      executableUsd: 900_000,
      completionRatio: 0.9,
      commonModeKeys: ["protocol:dex-z"],
    });
    const lowerIndependentDexA = exitRoute({ ...lowerIndependentDexZ, routeId: "dex:a" });
    const redemption = exitRoute({
      routeId: "redemption:best",
      output: { kind: "fiat", currency: "USD" },
      commonModeKeys: ["issuer:example"],
    });
    const result = computeEffectiveExitScoreDiagnostics(80, 80, {
      modeledExitSizeUsd: 1_000_000,
      dexExitRouteObservations: [highCorrelatedDex, lowerIndependentDexZ, lowerIndependentDexA],
      redemptionExitRouteObservations: [redemption],
      routeExitCorrelation: "independent-issuer-rail",
      sameNotionalScoringMode: "active",
      exitObservationAsOfSec: 1_100,
      dexExitObservationMaxAgeSec: 1_000,
      liveRedemptionExitObservationMaxAgeSec: 1_000,
      modelConfidence: "high",
    });

    expect(result.score).toBe(87);
    expect(result.comparedRouteIds).toEqual({ dex: "dex:a", redemption: "redemption:best" });
    expect(result.dexRouteScore).toBe(72);
    expect(result.redemptionRouteScore).toBe(80);
  });
});

describe("redemption exit route observation envelope", () => {
  it("accepts old capacity profiles and optional observations in the same JSON envelope", () => {
    expect(
      RedemptionCapacityProfileSchema.parse({
        scoringHorizon: "immediate",
        capacityProfileConfidence: "documented-bound",
      }).exitRouteObservations,
    ).toBeUndefined();
    expect(
      RedemptionCapacityProfileSchema.parse({
        scoringHorizon: "immediate",
        capacityProfileConfidence: "live-direct",
        exitRouteObservations: [exitRoute()],
      }).exitRouteObservations,
    ).toHaveLength(1);
  });

  it("enforces lane families and keeps eventual routes diagnostic-only", () => {
    const dex = exitRoute({
      routeFamily: "dex-orderbook",
      evidenceKind: "direct-orderbook-depth",
    });
    const redemption = exitRoute();
    const eventual = exitRoute({
      routeFamily: "eventual-redemption",
      evidenceKind: "documented-terms",
      scoreEligible: false,
    });

    expect(DexExitRouteObservationSchema.safeParse(dex).success).toBe(true);
    expect(DexExitRouteObservationSchema.safeParse(redemption).success).toBe(false);
    expect(RedemptionExitRouteObservationSchema.safeParse(redemption).success).toBe(true);
    expect(RedemptionExitRouteObservationSchema.safeParse(dex).success).toBe(false);
    expect(RedemptionExitRouteObservationSchema.safeParse(eventual).success).toBe(true);
    expect(RedemptionExitRouteObservationSchema.safeParse({ ...eventual, scoreEligible: true }).success).toBe(false);
    expect(
      RedemptionCapacityProfileSchema.safeParse({
        scoringHorizon: "immediate",
        capacityProfileConfidence: "live-direct",
        exitRouteObservations: [dex],
      }).success,
    ).toBe(false);
  });
});

describe("isStrongLiveDirectRoute", () => {
  it("requires direct live capacity, dynamic source mode, and immediate exercisability", () => {
    const base = {
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      sourceMode: "dynamic",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
    } as const;

    expect(isStrongLiveDirectRoute(base)).toBe(true);
    expect(isStrongLiveDirectRoute({ ...base, capacityConfidence: "live-proxy" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, sourceMode: "static" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, accessModel: "issuer-api" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, settlementModel: "days" })).toBe(false);
  });
});

describe("computeCapacityScore", () => {
  it("returns null when both inputs are null", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: null });
    expect(result.score).toBeNull();
    expect(result.coverageRatioScore).toBeNull();
    expect(result.absoluteCapacityScore).toBeNull();
  });

  it("scores exact breakpoints for coverage ratio", () => {
    // ratio=0 → 0, ratio=0.5 → 100
    const zero = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0 });
    expect(zero.coverageRatioScore).toBe(0);

    const full = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.5 });
    expect(full.coverageRatioScore).toBe(100);

    const quarter = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(quarter.coverageRatioScore).toBe(80);
  });

  it("interpolates between breakpoints", () => {
    // ratio=0.075 → between 0.05(40) and 0.10(60), midpoint = 50
    const mid = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.075 });
    expect(mid.coverageRatioScore).toBe(50);
  });

  it("blends ratio (60%) and absolute (40%)", () => {
    // ratio=0.5→100, usd=250M→100 → 100*0.6 + 100*0.4 = 100
    const result = computeCapacityScore({ immediateCapacityUsd: 250_000_000, immediateCapacityRatio: 0.5 });
    expect(result.score).toBe(100);

    // ratio=0→0, usd=0→0 → 0
    const low = computeCapacityScore({ immediateCapacityUsd: 0, immediateCapacityRatio: 0 });
    expect(low.score).toBe(0);
  });

  it("uses available score when only one dimension exists", () => {
    // Only ratio: coverage=score, absolute=score (fallback), blend = score
    const ratioOnly = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(ratioOnly.score).toBe(80); // 80*0.6 + 80*0.4 = 80
    expect(ratioOnly.absoluteCapacityScore).toBeNull();
  });

  it("clamps ratio > 1 to the top breakpoint", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 2 });
    expect(result.coverageRatioScore).toBe(100);
  });

  it("returns null for negative ratio", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: -0.1 });
    expect(result.coverageRatioScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for negative USD", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: -1000, immediateCapacityRatio: null });
    expect(result.absoluteCapacityScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    const nan = computeCapacityScore({ immediateCapacityUsd: NaN, immediateCapacityRatio: null });
    expect(nan.score).toBeNull();
    const inf = computeCapacityScore({ immediateCapacityUsd: Infinity, immediateCapacityRatio: null });
    expect(inf.score).toBeNull();
  });

  it("scores exact ratio breakpoints", () => {
    const bp001 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.01 });
    expect(bp001.coverageRatioScore).toBe(20);
    const bp005 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.05 });
    expect(bp005.coverageRatioScore).toBe(40);
    const bp010 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.1 });
    expect(bp010.coverageRatioScore).toBe(60);
    const bp025 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(bp025.coverageRatioScore).toBe(80);
  });

  it("scores exact USD breakpoints", () => {
    const bp100k = computeCapacityScore({ immediateCapacityUsd: 100_000, immediateCapacityRatio: null });
    expect(bp100k.absoluteCapacityScore).toBe(20);
    const bp1m = computeCapacityScore({ immediateCapacityUsd: 1_000_000, immediateCapacityRatio: null });
    expect(bp1m.absoluteCapacityScore).toBe(40);
    const bp10m = computeCapacityScore({ immediateCapacityUsd: 10_000_000, immediateCapacityRatio: null });
    expect(bp10m.absoluteCapacityScore).toBe(60);
    const bp50m = computeCapacityScore({ immediateCapacityUsd: 50_000_000, immediateCapacityRatio: null });
    expect(bp50m.absoluteCapacityScore).toBe(80);
    const bp250m = computeCapacityScore({ immediateCapacityUsd: 250_000_000, immediateCapacityRatio: null });
    expect(bp250m.absoluteCapacityScore).toBe(100);
  });

  it("handles USD beyond top breakpoint without overflow", () => {
    const huge = computeCapacityScore({ immediateCapacityUsd: 1_000_000_000_000, immediateCapacityRatio: null });
    expect(huge.absoluteCapacityScore).toBe(100);
  });

  it("uses tier-floor scoring for fixed USD capacity when supply is missing", () => {
    const result = computeCapacityScore({
      immediateCapacityUsd: 5_000_000,
      immediateCapacityRatio: null,
      absoluteOnlyMode: "tier-floor",
    });
    expect(result.absoluteCapacityScore).toBe(40);
    expect(result.score).toBe(40);
  });
});

describe("applyCapacityConstraintScoreEffects", () => {
  it("does not penalize missing optional telemetry", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 80,
        scoringCapacityUsd: 10_000_000,
      }),
    ).toEqual({ score: 80, capsApplied: [] });
  });

  it("penalizes adverse live queue, delay, minimum size, and eligibility telemetry", () => {
    const result = applyCapacityConstraintScoreEffects({
      capacityScore: 80,
      scoringCapacityUsd: 10_000_000,
      settlementDelaySec: 172_800,
      queueDepthUsd: 12_000_000,
      minRedeemUsd: 100_000,
      liveHolderEligibility: "whitelisted-primary",
    });

    expect(result.score).toBeLessThan(80);
    expect(result.capsApplied).toEqual([
      "settlement-delay-penalty",
      "queue-depth-penalty",
      "minimum-size-penalty",
      "live-holder-eligibility-penalty",
    ]);
  });

  it("applies settlement-delay penalties only above each threshold", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 3_600,
      }),
    ).toEqual({
      score: 100,
      capsApplied: [],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 3_601,
      }),
    ).toEqual({
      score: 90,
      capsApplied: ["settlement-delay-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 86_401,
      }),
    ).toEqual({
      score: 75,
      capsApplied: ["settlement-delay-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 604_801,
      }),
    ).toEqual({
      score: 60,
      capsApplied: ["settlement-delay-penalty"],
    });
  });

  it("applies minimum-size penalties only above retail-size thresholds", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 10_000,
      }),
    ).toEqual({
      score: 100,
      capsApplied: [],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 10_001,
      }),
    ).toEqual({
      score: 90,
      capsApplied: ["minimum-size-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 1_000_001,
      }),
    ).toEqual({
      score: 75,
      capsApplied: ["minimum-size-penalty"],
    });
  });
});

describe("computeRedemptionBackstopScore", () => {
  it("returns null when capacity is null", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: null,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBeNull();
    expect(result.capsApplied).toEqual([]);
  });

  it("computes weighted score correctly", () => {
    // All 100 → 100*0.20 + 100*0.15 + 100*0.15 + 100*0.25 + 100*0.15 + 100*0.10 = 100
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(100);
  });

  it("applies queue-redeem cap at 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("applies offchain-issuer cap at 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });

  it("applies config-level cap", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
      totalScoreCap: 50,
    });
    expect(result.score).toBe(50);
    expect(result.capsApplied).toContain("config-cap");
  });

  it("does not apply caps when score is below threshold", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 20,
      settlementScore: 20,
      executionCertaintyScore: 20,
      capacityScore: 20,
      outputAssetQualityScore: 20,
      costScore: 20,
    });
    expect(result.score).toBe(20);
    expect(result.capsApplied).toEqual([]);
  });

  it("does not apply route cap to uncapped families", () => {
    const families = ["stablecoin-redeem", "basket-redeem", "collateral-redeem", "psm-swap"] as const;
    for (const routeFamily of families) {
      const result = computeRedemptionBackstopScore({
        routeFamily,
        accessScore: 100,
        settlementScore: 100,
        executionCertaintyScore: 100,
        capacityScore: 100,
        outputAssetQualityScore: 100,
        costScore: 100,
      });
      expect(result.capsApplied).toEqual([]);
    }
  });

  it("queue-redeem cap is NOT applied when weighted score is exactly 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 70,
      settlementScore: 70,
      executionCertaintyScore: 70,
      capacityScore: 70,
      outputAssetQualityScore: 70,
      costScore: 70,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toEqual([]);
  });

  it("queue-redeem cap is applied when weighted score is 71", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 71,
      settlementScore: 71,
      executionCertaintyScore: 71,
      capacityScore: 71,
      outputAssetQualityScore: 71,
      costScore: 71,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("offchain-issuer cap is NOT applied when weighted score is exactly 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 65,
      settlementScore: 65,
      executionCertaintyScore: 65,
      capacityScore: 65,
      outputAssetQualityScore: 65,
      costScore: 65,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toEqual([]);
  });

  it("offchain-issuer cap is applied when weighted score is 66", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 66,
      settlementScore: 66,
      executionCertaintyScore: 66,
      capacityScore: 66,
      outputAssetQualityScore: 66,
      costScore: 66,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });
});

describe("isStrongLiveDirectRoute", () => {
  const strongInput = {
    capacityConfidence: "live-direct" as const,
    capacityKind: "live-direct" as const,
    sourceMode: "dynamic" as const,
    accessModel: "permissionless-onchain" as const,
    settlementModel: "atomic" as const,
  };

  it("returns true for live-direct dynamic permissionless atomic", () => {
    expect(isStrongLiveDirectRoute(strongInput)).toBe(true);
  });

  it("returns true for live-direct dynamic permissionless immediate", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "immediate" })).toBe(true);
  });

  it("returns true for explicit bounded live-direct capacity kind", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-direct-bounded" })).toBe(true);
  });

  it("returns false when the live capacity kind is missing", () => {
    expect(
      isStrongLiveDirectRoute({
        capacityConfidence: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      }),
    ).toBe(false);
  });

  it("returns false when the live capacity kind is proxy or queue evidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-proxy-validated" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-queue" })).toBe(false);
  });

  it("returns false for live-proxy capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "live-proxy" })).toBe(false);
  });

  it("returns false for documented-bound capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "documented-bound" })).toBe(false);
  });

  it("returns false for heuristic capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "heuristic" })).toBe(false);
  });

  it("returns false for dynamic legacy capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "dynamic" })).toBe(false);
  });

  it("returns false for estimated source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "estimated" })).toBe(false);
  });

  it("returns false for static source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "static" })).toBe(false);
  });

  it("returns false for whitelisted-onchain access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "whitelisted-onchain" })).toBe(false);
  });

  it("returns false for issuer-api access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "issuer-api" })).toBe(false);
  });

  it("returns false for manual access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "manual" })).toBe(false);
  });

  it("returns false for same-day settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "same-day" })).toBe(false);
  });

  it("returns false for queued settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "queued" })).toBe(false);
  });

  it("returns false for days settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "days" })).toBe(false);
  });
});
