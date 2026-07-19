import { describe, expect, it } from "vitest";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";

const NOW = Date.UTC(2026, 6, 13) / 1_000;

function supplyFullRow(overrides: Partial<RedemptionBackstopEntry> = {}): RedemptionBackstopEntry {
  return {
    stablecoinId: "usdc-circle",
    score: null,
    effectiveExitScore: null,
    dexLiquidityScore: null,
    accessScore: 40,
    settlementScore: 65,
    executionCertaintyScore: 60,
    capacityScore: null,
    outputAssetQualityScore: 100,
    costScore: 40,
    routeFamily: "offchain-issuer",
    accessModel: "issuer-api",
    settlementModel: "atomic",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    provider: "supply-full-model",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "verified-customer",
    capacityConfidence: "documented-bound",
    capacitySemantics: "eventual-only",
    capacityProfile: {
      immediateUsd: null,
      eventualUsd: 100_000_000,
      scoringUsd: null,
      scoringHorizon: "eventual",
      capacityProfileConfidence: "documented-bound",
      modeledExitSizeUsd: 5_000_000,
    },
    feeConfidence: "fixed",
    feeModelKind: "fixed-bps",
    modelConfidence: "medium",
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    feeBps: 10,
    queueEnabled: false,
    methodologyVersion: "4.18",
    updatedAt: NOW,
    docs: { label: "Terms", url: "https://example.com/terms", reviewedAt: "2026-07-01" },
    ...overrides,
  };
}

function fixedInputStub(row: RedemptionBackstopEntry | undefined): ReportCardsFixedInput {
  return {
    clockSec: NOW,
    dexGenerationId: "dex-liquidity-1",
    redemptionGenerationId: "redemption-backstops-1",
    dexLiqMap: {},
    redemptionBackstopMap: row ? { [row.stablecoinId]: row } : {},
    pegDataById: {},
  } as unknown as ReportCardsFixedInput;
}

function liveDirectRow(routeStatusSource: RedemptionBackstopEntry["routeStatusSource"]): RedemptionBackstopEntry {
  const row = supplyFullRow();
  const observation = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), row.stablecoinId)[0]!.observation;
  return {
    ...row,
    sourceMode: "dynamic",
    capacityConfidence: "live-direct",
    capacityKind: "live-direct-bounded",
    routeStatusSource,
    modelConfidence: "high",
    capacityProfile: {
      ...row.capacityProfile!,
      exitRouteObservations: [
        {
          ...observation,
          evidenceKind: "onchain-contract-state",
          confidence: "high",
          scoreEligible: true,
        },
      ],
    },
  };
}

describe("buildSafetyScoreV9RetainedRedemptionRoutes", () => {
  it("derives one retained route for a full-supply row without observations", () => {
    const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(supplyFullRow()), "usdc-circle");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      lane: "redemption",
      disposition: "observed",
      rejection: null,
      observation: {
        routeId: "redemption:usdc-circle:offchain-issuer",
        routeFamily: "issuer-redemption",
        scoreEligible: true,
        evidenceKind: "documented-terms",
      },
    });
  });

  it("pairs every retained route with a matching route review", () => {
    const fixedInput = fixedInputStub(supplyFullRow());
    const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, "usdc-circle");
    const reviews = buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle");
    expect(reviews.map((review) => `${review.lane}:${review.routeId}`)).toEqual(
      retained.map((route) => `${route.lane}:${route.observation.routeId}`),
    );
    expect(reviews[0]).toMatchObject({
      settlementModel: "atomic",
      settlementSlaSec: 0,
      modelConfidence: "medium",
    });
  });

  it("preserves the captured redemption model-confidence rollup", () => {
    const fixedInput = fixedInputStub(supplyFullRow({ modelConfidence: "high" }));
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      lane: "redemption",
      executionCertainty: "bounded",
      modelConfidence: "high",
    });
  });

  it("fails static-open live-direct evidence closed only at the v9 adapter", () => {
    const row = liveDirectRow("static-config");
    expect(row.capacityProfile?.exitRouteObservations?.[0]?.scoreEligible).toBe(true);
    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
      lane: "redemption",
      coverageClass: "diagnostic",
      modelConfidence: "high",
    });
  });

  it.each(["onchain", "protocol-api"] as const)("keeps %s-sourced live-direct evidence scoreable", (source) => {
    const row = liveDirectRow(source);
    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
      lane: "redemption",
      coverageClass: "exact-lower-bound",
      modelConfidence: "high",
    });
  });

  it("values a resolved stable-basket output at the weakest component's price", () => {
    const row = supplyFullRow({ stablecoinId: "dai-makerdao" });
    const derived = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), "dai-makerdao")[0]!;
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        {
          ...derived.observation,
          output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle", "usdt-tether"] },
        },
      ],
    };
    const fixedInput = fixedInputStub(row);
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdc-circle": { currentDeviationBps: 2, priceObservedAt: NOW },
      "usdt-tether": { currentDeviationBps: -14, priceObservedAt: NOW },
    };
    const review = buildSafetyScoreV9RouteReviews(fixedInput, "dai-makerdao")[0]!;
    expect(review.output).toMatchObject({
      kind: "tracked-stablecoin",
      assetKeys: ["usdc-circle", "usdt-tether"],
      valuation: {
        basis: "price",
        referenceAssetKey: "usdt-tether",
        unitValueUsd: 1 - 14 / 10_000,
        confidence: "medium",
      },
    });

    // A partially-priced basket stays unresolved instead of guessing.
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdc-circle": { currentDeviationBps: 2, priceObservedAt: NOW },
    };
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "dai-makerdao")[0]!.output?.valuation).toBeNull();
  });

  it("values production-shaped tracked DEX output aliases by canonical stablecoin id", () => {
    const fixedInput = fixedInputStub(undefined);
    const route: ExitRouteObservation = {
      routeId:
        "dex:asset-input:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool:ethereum%3A0xfa2b947eec368f42195f24f36d2af29f7c24cec2",
      routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
      requestedNotionalUsd: 1_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 900_000,
      completionRatio: 0.9,
      output: {
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdf-falcon"],
        assetKeys: ["ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2"],
      },
      evidenceKind: "reserve-based-amm-simulation",
      confidence: "high",
      scoreEligible: true,
      observedAt: NOW,
      freshnessSeconds: 0,
      commonModeKeys: ["chain:ethereum", "protocol:curve"],
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "asset-input": {
        exitRouteObservations: [route],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.4",
          retainedPoolCount: 2_418,
          observationCount: 44,
          scoreEligibleObservationCount: 44,
          scoreEligiblePoolCount: 38,
          scoreEligibleCapabilityPoolCount: 38,
          unsupportedPoolCount: 2_380,
          evidenceCounts: { "reserve-based-amm-simulation": 44 },
          unsupportedReasons: {
            "nonExecutableEvidence:defillama-pool-shaped": 1_449,
            "nonExecutableEvidence:curve-stableswap-shaped": 11,
            "nonExecutableEvidence:direct-api-amm-shaped": 653,
            "nonExecutableEvidence:discovery-pool-shaped": 267,
          },
        },
      },
    };
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdf-falcon": { currentDeviationBps: -12, priceObservedAt: NOW },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "asset-input")).toEqual([
      expect.objectContaining({
        lane: "dex",
        routeId: route.routeId,
        modelConfidence: "medium",
        coverageClass: "exact-complete",
        output: expect.objectContaining({
          kind: "tracked-stablecoin",
          assetKeys: ["usdf-falcon"],
          valuation: expect.objectContaining({
            referenceAssetKey: "usdf-falcon",
            unitValueUsd: 0.9988,
          }),
        }),
      }),
    ]);
  });

  it("derives nothing when the row already carries observations or is absent", () => {
    const withObservation = supplyFullRow();
    const derived = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(withObservation), "usdc-circle")[0]!;
    withObservation.capacityProfile = {
      ...withObservation.capacityProfile!,
      exitRouteObservations: [derived.observation],
    };
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(withObservation), "usdc-circle")).toEqual([]);
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(undefined), "usdc-circle")).toEqual([]);
  });
});

describe("buildDexRouteReview model-confidence derivation", () => {
  function dexObservation(evidenceKind: ExitRouteObservation["evidenceKind"]): ExitRouteObservation {
    return {
      routeId: `dex:usdc-circle:dl:ethereum%3Apool:${evidenceKind}`,
      routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: `pool-${evidenceKind}`, protocol: "curve" },
      requestedNotionalUsd: 1_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 50,
      executableUsd: 950_000,
      completionRatio: 0.95,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind,
      confidence: "high",
      scoreEligible: true,
      observedAt: NOW,
      freshnessSeconds: 0,
      commonModeKeys: ["chain:ethereum", "protocol:curve"],
    };
  }

  function dexReviewFor(evidenceKind: ExitRouteObservation["evidenceKind"]) {
    const fixedInput = fixedInputStub(undefined);
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [dexObservation(evidenceKind)] },
    };
    return buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]!;
  }

  it("grades measured executable depth as high model confidence", () => {
    expect(dexReviewFor("measured-executable-depth")).toMatchObject({
      lane: "dex",
      executionCertainty: "bounded",
      modelConfidence: "high",
    });
  });

  it.each([
    "reserve-based-amm-simulation",
    "direct-orderbook-depth",
    "generic-tvl-proxy",
    "synthetic-or-fallback",
    "unobserved",
  ] as const)("keeps %s evidence at medium model confidence", (evidenceKind) => {
    expect(dexReviewFor(evidenceKind)).toMatchObject({
      lane: "dex",
      executionCertainty: "bounded",
      modelConfidence: "medium",
    });
  });

  it("lifts only the measured route when evidence kinds are mixed", () => {
    const fixedInput = fixedInputStub(undefined);
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": {
        exitRouteObservations: [
          dexObservation("reserve-based-amm-simulation"),
          dexObservation("measured-executable-depth"),
        ],
      },
    };
    const reviews = buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle");
    expect(reviews).toHaveLength(2);
    expect(
      reviews.find((review) => review.routeId.includes("measured-executable-depth")),
    ).toMatchObject({ modelConfidence: "high" });
    expect(
      reviews.find((review) => review.routeId.includes("reserve-based-amm-simulation")),
    ).toMatchObject({ modelConfidence: "medium" });
  });
});
