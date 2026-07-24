import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { createReportCardsFixedInput, type ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";

const NOW = Date.UTC(2026, 6, 13) / 1_000;
const V9_FIXTURE_CLOCK = Date.UTC(2027, 0, 1) / 1_000;

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

function capturedNavOutputInput(navObservedAtSec: number): ReportCardsFixedInput {
  const route: ExitRouteObservation = {
    routeId: "dex:usdaf-asymmetry:dl:ethereum%3Apool:ethereum%3Athbill-output",
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 900_000,
    completionRatio: 0.9,
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["thbill-theo"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt: V9_FIXTURE_CLOCK,
    freshnessSeconds: 0,
    commonModeKeys: ["chain:ethereum", "protocol:curve"],
  };
  return createReportCardsFixedInput({
    captureKind: "public-reconstruction",
    activeAssetIds: ["usdaf-asymmetry"],
    capturedAt: new Date(V9_FIXTURE_CLOCK * 1_000).toISOString(),
    sourceGeneration: "report-cards:nav-output-fixture",
    dexGenerationId: "dex-liquidity-nav-output-fixture",
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:nav-output-fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: V9_FIXTURE_CLOCK,
    updatedAt: V9_FIXTURE_CLOCK,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: V9_FIXTURE_CLOCK, ageSeconds: 0, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    navPriceById: {
      "thbill-theo": {
        priceUsd: 1.0188,
        sourceId: "defillama-contract",
        observedAtSec: navObservedAtSec,
        confidence: "high",
      },
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      "usdaf-asymmetry": {
        liquidityScore: 50,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        exitRouteObservations: [route],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.6",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
        methodologyVersion: "dex:fixture-v1",
        updatedAt: V9_FIXTURE_CLOCK,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { "usdaf-asymmetry": false },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
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

  it("projects reviewed fixed and minimum fees when captured rows omit feeBps", () => {
    const row = supplyFullRow({
      stablecoinId: "usdt-tether",
      feeBps: null,
      feeConfidence: "undisclosed-reviewed",
      feeModelKind: "documented-variable",
    });
    const review = buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]!;

    expect(review.executionCosts).toEqual(
      expect.arrayContaining([
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executionCostBps: 100 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executionCostBps: 10 },
        { requestedNotionalUsd: 5_000_000, maxCostBps: 200, executionCostBps: 10 },
        { requestedNotionalUsd: 25_000_000, maxCostBps: 200, executionCostBps: 10 },
      ]),
    );

    const fixedFeeRow = supplyFullRow({
      stablecoinId: "ousd-origin-protocol",
      feeBps: null,
    });
    const fixedFeeReview = buildSafetyScoreV9RouteReviews(
      fixedInputStub(fixedFeeRow),
      fixedFeeRow.stablecoinId,
    )[0]!;
    expect(fixedFeeReview.executionCosts.every((point) => point.executionCostBps === 25)).toBe(true);
  });

  it("projects conservative USDT-only reviewed constraints without changing the captured row", () => {
    const row = supplyFullRow({
      stablecoinId: "usdt-tether",
      settlementModel: "same-day",
      settlementDelaySec: undefined,
      minRedeemUsd: undefined,
      holderEligibility: "verified-customer",
    });
    const review = buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]!;

    expect(row).toMatchObject({ settlementModel: "same-day", holderEligibility: "verified-customer" });
    expect(row.minRedeemUsd).toBeUndefined();
    expect(review).toMatchObject({
      holderAccess: "institutional-eligible",
      settlementModel: "bounded-delay",
      settlementSlaSec: null,
      settlementHorizonSec: 14 * 86_400,
      minRedeemUsd: 100_000,
    });
  });

  it("keeps pinned redemption fee and output valuation separate in the route review", () => {
    const row = supplyFullRow({ stablecoinId: "fpi-frax", feeBps: null });
    const observation = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), row.stablecoinId)[0]!
      .observation;
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        {
          ...observation,
          output: { kind: "tracked-stablecoin", trackedAssetIds: ["frax-frax"] },
          evidenceKind: "onchain-contract-state",
          executionCostBps: 30,
          outputUnitValueUsd: 0.98836526,
          allInCostBps: 145.9983578,
          modelConfidence: "high",
          scoreEligible: true,
        },
      ],
    };
    const fixedInput = fixedInputStub(row);
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "frax-frax": { currentDeviationBps: -500, priceObservedAt: NOW },
    };
    const review = buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!;

    expect(review.executionCosts.every((point) => point.executionCostBps === 30)).toBe(true);
    expect(review).toMatchObject({ executionCertainty: "bounded", modelConfidence: "high" });
    expect(review.output).toMatchObject({
      kind: "tracked-stablecoin",
      valuation: {
        basis: "price",
        referenceAssetKey: "frax-frax",
        unitValueUsd: 0.98836526,
        sourceId: "redemption-route-pinned-output-value",
        confidence: "high",
      },
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

  it("carries a live 30-day queue and its capacity constraints into the v9 route review", () => {
    const row = liveDirectRow("protocol-api");
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    row.settlementModel = "queued";
    row.queueEnabled = true;
    row.settlementDelaySec = 30 * 86_400;
    row.queueDepthUsd = 12_000_000;
    row.dailyLimitUsd = 5_000_000;
    row.minRedeemUsd = 100_000;
    row.capacityProfile = {
      ...row.capacityProfile!,
      scoringHorizon: "queued",
      dailyLimitUsd: 5_000_000,
      queuedUsd: 12_000_000,
      exitRouteObservations: [
        {
          ...observation,
          settlementHorizonSec: 30 * 86_400,
          scoreEligible: false,
        },
      ],
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
      lane: "redemption",
      capacityScoringHorizon: "queued",
      settlementModel: "queued",
      settlementSlaSec: 30 * 86_400,
      queueDepthUsd: 12_000_000,
      dailyLimitUsd: 5_000_000,
      minRedeemUsd: 100_000,
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
          capabilityMatrixVersion: "p4a.6",
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

  it("values a NAV output from the captured NAV price without creating a peg valuation", () => {
    const fixedInput = fixedInputStub(undefined);
    const route: ExitRouteObservation = {
      routeId: "dex:asset-input:dl:ethereum%3Apool:ethereum%3Anav-output",
      routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
      requestedNotionalUsd: 1_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 900_000,
      completionRatio: 0.9,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["thbill-theo"] },
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
          capabilityMatrixVersion: "p4a.6",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
      },
    };
    (fixedInput as { navPriceById: Record<string, unknown> }).navPriceById = {
      "thbill-theo": {
        priceUsd: 1.0188,
        sourceId: "defillama-contract",
        observedAtSec: NOW,
        confidence: "high",
      },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "asset-input")[0]?.output?.valuation).toMatchObject({
      basis: "nav",
      referenceAssetKey: "thbill-theo",
      unitValueUsd: 1.0188,
      expectedUnitValueUsd: 1.0188,
      sourceId: "defillama-contract",
    });
  });

  it("includes captured NAV observations in V9 peg-source provenance", () => {
    const olderInput = capturedNavOutputInput(V9_FIXTURE_CLOCK - 60);
    const newerInput = capturedNavOutputInput(V9_FIXTURE_CLOCK - 30);
    const olderExtension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(olderInput);
    const newerExtension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(newerInput);

    expect(newerInput.baseInputGenerationId).not.toBe(olderInput.baseInputGenerationId);
    expect(newerExtension.sources.peg).toMatchObject({ observedAtSec: V9_FIXTURE_CLOCK - 30 });
    expect(newerExtension.sources.peg.generationId).not.toBe(olderExtension.sources.peg.generationId);
    expect(newerExtension.assets[0]?.routeReviews[0]?.output?.valuation).toMatchObject({
      basis: "nav",
      sourceId: "defillama-contract",
      observedAtSec: V9_FIXTURE_CLOCK - 30,
    });
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
  function dexObservation(
    evidenceKind: ExitRouteObservation["evidenceKind"],
    mature = false,
  ): ExitRouteObservation {
    const observation: ExitRouteObservation = {
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
    if (evidenceKind === "measured-executable-depth" && mature) {
      const conservativeCapacityCurve = [
        {
          requestedNotionalUsd: observation.requestedNotionalUsd,
          maxCostBps: observation.maxCostBps,
          executableUsd: observation.executableUsd,
          completionRatio: observation.completionRatio,
        },
      ];
      observation.observationHistory = {
        completeProducerCycleCount: 2,
        successfulObservationCount: 2,
        consecutiveSuccessCount: 2,
        observationWindowStartedAt: NOW - 1_800,
        observationWindowEndedAt: NOW,
        latestOperationalFailureAt: null,
        conservativeStatistic: "pointwise-minimum",
        conservativeCapacityCurve,
      };
      observation.capacityCurve = conservativeCapacityCurve;
    }
    return observation;
  }

  function dexReviewFor(evidenceKind: ExitRouteObservation["evidenceKind"], mature = false) {
    const fixedInput = fixedInputStub(undefined);
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [dexObservation(evidenceKind, mature)] },
    };
    return buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]!;
  }

  it("bounds a single measured cycle at medium model confidence", () => {
    expect(dexReviewFor("measured-executable-depth")).toMatchObject({
      lane: "dex",
      executionCertainty: "bounded",
      modelConfidence: "medium",
    });
  });

  it("uses realized measured cost and preserves the legacy request-bound fallback", () => {
    const fixedInput = fixedInputStub(undefined);
    const realized = dexObservation("measured-executable-depth");
    realized.capacityCurve = [
      {
        requestedNotionalUsd: realized.requestedNotionalUsd,
        maxCostBps: realized.maxCostBps,
        executableUsd: realized.executableUsd,
        completionRatio: realized.completionRatio,
        executionCostBps: 37,
      },
    ];
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [realized] },
    };
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]?.executionCosts).toEqual([
      { requestedNotionalUsd: 1_000_000, maxCostBps: 50, executionCostBps: 37 },
    ]);

    delete realized.capacityCurve[0]!.executionCostBps;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]?.executionCosts).toEqual([
      { requestedNotionalUsd: 1_000_000, maxCostBps: 50, executionCostBps: 50 },
    ]);
  });

  it("grades repeated measured executable depth as high model confidence", () => {
    expect(dexReviewFor("measured-executable-depth", true)).toMatchObject({
      lane: "dex",
      executionCertainty: "bounded",
      modelConfidence: "high",
    });
  });

  it("does not retain high model confidence after measured history expires", () => {
    const fixedInput = fixedInputStub(undefined);
    const observation = dexObservation("measured-executable-depth", true);
    observation.observationHistory = {
      ...observation.observationHistory!,
      observationWindowStartedAt: NOW - 4_000,
      observationWindowEndedAt: NOW - 3_601,
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [observation] },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      modelConfidence: "medium",
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
          dexObservation("measured-executable-depth", true),
        ],
      },
    };
    const reviews = buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle");
    expect(reviews).toHaveLength(2);
    expect(reviews.find((review) => review.routeId.includes("measured-executable-depth"))).toMatchObject({
      modelConfidence: "high",
    });
    expect(reviews.find((review) => review.routeId.includes("reserve-based-amm-simulation"))).toMatchObject({
      modelConfidence: "medium",
    });
  });
});
