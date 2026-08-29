import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "@shared/types/measured-execution";
import {
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { createReportCardsFixedInput, type ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RetainedRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";

const NOW = Date.UTC(2026, 6, 13) / 1_000;
const V9_FIXTURE_CLOCK = Date.UTC(2027, 0, 1) / 1_000;

function singleObservationDexLiquidity(route: ExitRouteObservation): Record<string, unknown> {
  return {
    exitRouteObservations: [route],
    exitRouteObservationCoverage: {
      status: "populated",
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1,
      observationCount: 1,
      scoreEligibleObservationCount: 1,
      scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
      unsupportedReasons: {},
    },
  };
}

function fixedInputStub(
  row: RedemptionBackstopEntry | undefined,
  clockSec = NOW,
): ReportCardsFixedInput {
  return {
    clockSec,
    dexGenerationId: "dex-liquidity-1",
    redemptionGenerationId: "redemption-backstops-1",
    dexLiqMap: {},
    redemptionBackstopMap: row ? { [row.stablecoinId]: row } : {},
    pegDataById: {},
  } as unknown as ReportCardsFixedInput;
}

function withV9RouteReviewTerms<T>(
  stablecoinId: string,
  terms: NonNullable<RedemptionBackstopConfig["v9RouteReviewTerms"]>,
  run: () => T,
): T {
  const config = getRedemptionBackstopConfig(stablecoinId);
  if (!config) throw new Error(`Missing redemption config fixture for ${stablecoinId}`);
  const previous = config.v9RouteReviewTerms;
  config.v9RouteReviewTerms = terms;
  try {
    return run();
  } finally {
    if (previous === undefined) delete config.v9RouteReviewTerms;
    else config.v9RouteReviewTerms = previous;
  }
}

const FASTER_REVIEWED_SETTLEMENT = {
  settlementModel: "days",
  settlementDelaySec: 2 * 86_400,
  reviewedAt: "2026-07-01",
  docs: [
    {
      label: "Issuer redemption terms",
      url: "https://example.com/redemption-terms",
      supports: ["settlement"],
    },
  ],
} satisfies NonNullable<RedemptionBackstopConfig["v9RouteReviewTerms"]>;

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
          capabilityMatrixVersion: "p4a.9",
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
  const row = makeSupplyFullRedemption();
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
    const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(makeSupplyFullRedemption()), "usdc-circle");
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
    const fixedInput = fixedInputStub(makeSupplyFullRedemption());
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

  it("keeps an unmarked documented-bound route scoreable under the existing projection", () => {
    const row = makeSupplyFullRedemption();
    const fixedInput = fixedInputStub(row);

    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]).toMatchObject({
      lane: "redemption",
      coverageClass: "exact-lower-bound",
    });
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, row.stablecoinId)[0]).toMatchObject({
      observation: { evidenceKind: "documented-terms", scoreEligible: true },
    });
  });

  it("projects a bounded terms gap as diagnostic without mutating the frozen redemption row", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "xo-exodus",
      settlementModel: "same-day",
      feeBps: 0,
    });
    const frozenRow = structuredClone(row);
    const fixedInput = fixedInputStub(row);
    const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, row.stablecoinId)[0]!;
    const review = buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!;

    expect(getRedemptionBackstopConfig(row.stablecoinId)?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
    });
    expect(retained.observation).toMatchObject({
      evidenceKind: "documented-terms",
      scoreEligible: false,
      executableUsd: 5_000_000,
    });
    expect(review).toMatchObject({
      lane: "redemption",
      coverageClass: "diagnostic",
      executionCosts: expect.arrayContaining([
        expect.objectContaining({ executionCostBps: 0 }),
      ]),
    });
    expect(row).toEqual(frozenRow);
    expect(row).not.toHaveProperty("v9RouteReviewTerms");
    expect(row).not.toHaveProperty("scoringDisposition");
  });

  it("records capacity, settlement, and cost gaps distinctly while retaining partial terms", () => {
    const expectedMissingFields = {
      "axcnh-anchorx": ["capacity", "settlement", "cost"],
      "brla-brla-digital": ["capacity", "settlement", "cost"],
      "gbpsafo-spiko": ["capacity", "settlement", "cost"],
      "jaaa-janus-henderson-anemoy": ["capacity", "settlement", "cost"],
      "mapollo-midas": ["capacity", "settlement", "cost"],
      "mf-one-midas": ["capacity", "settlement"],
      "mhyper-midas": ["capacity", "settlement"],
      "mmev-midas": ["capacity", "settlement", "cost"],
      "mtbill-midas": ["capacity", "settlement"],
      "mxnb-juno": ["capacity", "settlement", "cost"],
      "qcad-stablecorp": ["capacity", "settlement", "cost"],
      "sbc-brale": ["capacity", "settlement", "cost"],
      "usd1-world-liberty-financial": ["capacity", "cost"],
      "usdn-noble": ["capacity", "settlement", "cost"],
      "vbill-vaneck": ["capacity", "settlement", "cost"],
      "wars-argentine-peso": ["capacity", "settlement", "cost"],
      "xo-exodus": ["settlement"],
    } as const;

    for (const [assetId, missingScoringFields] of Object.entries(expectedMissingFields)) {
      expect(getRedemptionBackstopConfig(assetId)?.v9RouteReviewTerms).toMatchObject({
        scoringDisposition: "bounded-terms-gap",
        missingScoringFields,
        reviewedAt: expect.any(String),
        rationale: expect.any(String),
        docs: expect.arrayContaining([expect.objectContaining({ url: expect.any(String) })]),
      });
    }

    expect(getRedemptionBackstopConfig("xo-exodus")?.costModel).toMatchObject({
      kind: "fee-bps",
      feeBps: 0,
    });
    expect(getRedemptionBackstopConfig("usd1-world-liberty-financial")?.v9RouteReviewTerms).toMatchObject({
      settlementModel: "days",
      settlementDelaySec: 172_800,
      missingScoringFields: ["capacity", "cost"],
    });
    expect(getRedemptionBackstopConfig("mtbill-midas")?.costModel).toMatchObject({
      kind: "fee-bps",
      feeBps: 7,
    });
  });

  it("preserves the captured redemption model-confidence rollup", () => {
    const fixedInput = fixedInputStub(makeSupplyFullRedemption({ modelConfidence: "high" }));
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      lane: "redemption",
      executionCertainty: "bounded",
      modelConfidence: "high",
    });
  });

  it("projects reviewed fixed and minimum fees when captured rows omit feeBps", () => {
    const row = makeSupplyFullRedemption({
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

    const fixedFeeRow = makeSupplyFullRedemption({
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
    const row = makeSupplyFullRedemption({
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

  it("projects an evidence-backed faster settlement into the scored SLA", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "msusd-main-street",
      settlementModel: "days",
      settlementDelaySec: undefined,
    });

    withV9RouteReviewTerms(row.stablecoinId, FASTER_REVIEWED_SETTLEMENT, () => {
      expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
        settlementModel: "bounded-delay",
        settlementSlaSec: 2 * 86_400,
      });
    });
  });

  it("does not re-widen an evidence-backed faster settlement horizon", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "msusd-main-street",
      settlementModel: "days",
      settlementDelaySec: undefined,
    });
    const fixedInput = fixedInputStub(row);

    withV9RouteReviewTerms(row.stablecoinId, FASTER_REVIEWED_SETTLEMENT, () => {
      expect(
        buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, row.stablecoinId)[0]?.observation
          .settlementHorizonSec,
      ).toBe(14 * 86_400);
      expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]?.settlementHorizonSec).toBe(
        2 * 86_400,
      );
    });
  });

  it("expires a faster reviewed settlement back to the conservative captured horizon", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "msusd-main-street",
      settlementModel: "days",
      settlementDelaySec: undefined,
    });
    const staleClock = Date.UTC(2027, 6, 2) / 1_000;

    withV9RouteReviewTerms(row.stablecoinId, FASTER_REVIEWED_SETTLEMENT, () => {
      expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row, staleClock), row.stablecoinId)[0]).toMatchObject({
        settlementModel: "bounded-delay",
        settlementSlaSec: null,
        settlementHorizonSec: 14 * 86_400,
      });
    });
  });

  it("expires a favorable settlement after the producer persisted its current reviewed model", () => {
    const stablecoinId = "usdy-ondo-finance";
    const config = getRedemptionBackstopConfig(stablecoinId)!;
    const currentClock = Date.UTC(2026, 7, 26) / 1_000;
    const staleClock = Date.UTC(2027, 7, 26) / 1_000;
    const producerSettlement = resolveReviewedRedemptionSettlement(config, currentClock);
    const row = makeSupplyFullRedemption({
      stablecoinId,
      settlementModel: producerSettlement,
      settlementDelaySec: 0,
    });

    expect(producerSettlement).toBe("atomic");
    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row, currentClock), stablecoinId)[0]).toMatchObject({
      settlementModel: "atomic",
      settlementSlaSec: 0,
    });
    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row, staleClock), stablecoinId)[0]).toMatchObject({
      settlementModel: "bounded-delay",
      settlementSlaSec: null,
      settlementHorizonSec: 14 * 86_400,
    });
  });

  it("keeps pinned redemption fee and output valuation separate in the route review", () => {
    const row = makeSupplyFullRedemption({ stablecoinId: "fpi-frax", feeBps: null });
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

  it("projects the eEARN atomic producer route onto its unbounded queued v9 review", () => {
    const row = liveDirectRow("onchain");
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    row.stablecoinId = "eearn-ember";
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        {
          ...observation,
          routeId: "redemption:eearn-ember:stablecoin-redeem",
          scope: { kind: "protocol", protocol: "eearn-ember", chain: "ethereum" },
          output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
          settlementHorizonSec: 300,
          settlementBoundUnproven: true,
          scoreEligible: false,
        },
      ],
    };

    expect(row).toMatchObject({ settlementModel: "atomic", queueEnabled: false });
    expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
      lane: "redemption",
      settlementModel: "queued",
      settlementSlaSec: null,
      settlementHorizonSec: 30 * 86_400,
      coverageClass: "exact-lower-bound",
    });
    expect(row.capacityProfile?.exitRouteObservations?.[0]?.settlementBoundUnproven).toBe(true);
  });

  it("values a resolved stable-basket output at the weakest component's price", () => {
    const row = makeSupplyFullRedemption({ stablecoinId: "dai-makerdao" });
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

  it("admits reviewed unresolved-output ownership only after the review date", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "dusd-dtrinity",
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
    });
    const historicalInput = fixedInputStub(
      row,
      Date.UTC(2026, 6, 13, 12) / 1_000,
    );
    const observation = buildSafetyScoreV9RetainedRedemptionRoutes(
      historicalInput,
      row.stablecoinId,
    )[0]!.observation;
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [observation],
    };

    expect(
      buildSafetyScoreV9RouteReviews(historicalInput, row.stablecoinId)[0]
        ?.unresolvedOutputResponsibility,
    ).toBeUndefined();
    expect(
      buildSafetyScoreV9RouteReviews(
        fixedInputStub(row, Date.UTC(2026, 6, 27, 12) / 1_000),
        row.stablecoinId,
      )[0]?.unresolvedOutputResponsibility,
    ).toBeUndefined();
    expect(
      buildSafetyScoreV9RouteReviews(
        fixedInputStub(row, Date.UTC(2026, 6, 28, 0, 0, 1) / 1_000),
        row.stablecoinId,
      )[0]?.unresolvedOutputResponsibility,
    ).toBe("producer-failed");
  });

  it("prices the dTRINITY vault-bridge receipt basket through each receipt's underlying", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "dusd-dtrinity",
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
    });
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), row.stablecoinId)[0]!.observation,
      ],
    };
    const fixedInput = fixedInputStub(row);
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = Object.fromEntries(
      (
        [
          ["usdc-circle", 3],
          ["usdt-tether", -21],
          ["usds-sky", 1],
          ["susds-sky", 4],
          ["frxusd-frax", -2],
          ["sfrxusd-frax", 5],
          ["dai-makerdao", -4],
          ["sdai-sky", 6],
          ["ausd-agora", -1],
        ] as const
      ).map(([assetId, deviationBps]) => [
        assetId,
        { currentDeviationBps: deviationBps, priceObservedAt: NOW },
      ]),
    );

    // vbUSDC/vbUSDT keep their captured untracked identities; only their value
    // comes from the reviewed one-for-one vault-bridge conversion.
    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!.output).toMatchObject({
      kind: "basket",
      assetKeys: [
        "asset:vbusdc",
        "asset:vbusdt",
        "ausd-agora",
        "dai-makerdao",
        "frxusd-frax",
        "sdai-sky",
        "sfrxusd-frax",
        "susds-sky",
        "usdc-circle",
        "usds-sky",
        "usdt-tether",
      ],
      valuation: {
        basis: "price",
        referenceAssetKey: "asset:vbusdt",
        unitValueUsd: 1 - 21 / 10_000,
        expectedUnitValueUsd: 1,
        sourceId: "safety-score-v9-extension-fixed-rate-receipt",
        confidence: "medium",
      },
    });

    // Dropping the receipts' underlying leaves the basket unresolved rather
    // than valuing it from the remaining legs.
    const { "usdt-tether": _dropped, ...withoutUnderlying } = fixedInput.pegDataById;
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = withoutUnderlying;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!.output).toBeNull();
  });

  it("leaves an unresolved basket unresolved when a leg has no reviewed conversion", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "dllr-sovryn",
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
    });
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), row.stablecoinId)[0]!.observation,
      ],
    };
    const fixedInput = fixedInputStub(row, Date.UTC(2026, 6, 28, 0, 0, 1) / 1_000);
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "doc-money-on-chain": { currentDeviationBps: -5, priceObservedAt: NOW },
    };
    const review = buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!;
    expect(review.output).toBeNull();
    expect(review.unresolvedOutputResponsibility).toBe("producer-failed");
  });

  it.each(["srusd-reservoir", "wsrusd-reservoir"] as const)(
    "values the composed %s redemption route through its final USDC output",
    (stablecoinId) => {
      const row = makeSupplyFullRedemption({
        stablecoinId,
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        holderEligibility: "any-holder",
      });
      const fixedInput = fixedInputStub(row);
      const observation = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, stablecoinId)[0]!.observation;
      row.capacityProfile = {
        ...row.capacityProfile!,
        exitRouteObservations: [observation],
      };
      (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
        "usdc-circle": { currentDeviationBps: -3, priceObservedAt: NOW },
      };

      expect(buildSafetyScoreV9RouteReviews(fixedInput, stablecoinId)[0]?.output).toMatchObject({
        kind: "tracked-stablecoin",
        assetKeys: ["usdc-circle"],
        valuation: {
          basis: "price",
          referenceAssetKey: "usdc-circle",
          unitValueUsd: 0.9997,
          expectedUnitValueUsd: 1,
          sourceId: "report-cards-peg-summary",
        },
      });
    },
  );

  it("values a quiet scored tracked-stablecoin output at par", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "zys-zephyr-protocol",
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      holderEligibility: "any-holder",
      outputAssetType: "stable-single",
    });
    const fixedInput = fixedInputStub(row);
    const observation = buildSafetyScoreV9RetainedRedemptionRoutes(
      fixedInput,
      row.stablecoinId,
    )[0]!.observation;
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [
        {
          ...observation,
          output: {
            kind: "tracked-stablecoin",
            trackedAssetIds: ["zsd-zephyr-protocol"],
          },
        },
      ],
    };
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "zsd-zephyr-protocol": {
        currentDeviationBps: null,
        pegScore: 100,
        activeDepeg: false,
        eventCount: 0,
        worstDeviationBps: null,
      },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]?.output).toMatchObject({
      kind: "tracked-stablecoin",
      assetKeys: ["zsd-zephyr-protocol"],
      valuation: {
        basis: "price",
        referenceAssetKey: "zsd-zephyr-protocol",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        sourceId: "report-cards-peg-summary",
      },
    });
  });

  it("uses a complete source-bound producer valuation for CUSD when WTGXX has no peg row", () => {
    const reviewedRow = makeSupplyFullRedemption({
      stablecoinId: "cusd-cap",
      routeFamily: "basket-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
      feeBps: 0,
    });
    const observation = buildSafetyScoreV9RetainedRedemptionRoutes(
      fixedInputStub(reviewedRow),
      reviewedRow.stablecoinId,
    )[0]!.observation;
    const row = {
      ...reviewedRow,
      sourceMode: "dynamic",
      routeStatusSource: "onchain",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      modelConfidence: "high",
    } satisfies RedemptionBackstopEntry;
    row.capacityProfile = {
      ...row.capacityProfile!,
      scoringUsd: 30_000_000,
      scoringHorizon: "immediate",
      exitRouteObservations: [
        {
          ...observation,
          output: {
            kind: "tracked-stablecoin",
            trackedAssetIds: ["usdc-circle", "wtgxx-wisdomtree"],
            basketWeights: [
              { assetId: "usdc-circle", weight: 0.93 },
              { assetId: "wtgxx-wisdomtree", weight: 0.07 },
            ],
          },
          evidenceKind: "onchain-contract-state",
          confidence: "high",
          executionCostBps: 0,
          outputUnitValueUsd: 0.999983,
          outputUnitValueSourceId:
            "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
          outputUnitValueObservedAt: NOW - 120,
          allInCostBps: 0.17,
          scoreEligible: true,
          observedAt: NOW,
          freshnessSeconds: 0,
        },
      ],
    };
    const fixedInput = fixedInputStub(row);
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdc-circle": { currentDeviationBps: 2, priceObservedAt: NOW },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "cusd-cap")[0]?.output).toMatchObject({
      basketWeights: [
        { assetKey: "usdc-circle", weight: 0.93 },
        { assetKey: "wtgxx-wisdomtree", weight: 0.07 },
      ],
      valuation: {
        basis: "price",
        referenceAssetKey: "basket:redemption:cusd-cap:basket-redeem",
        unitValueUsd: 0.999983,
        expectedUnitValueUsd: 1,
        sourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
        observedAtSec: NOW - 120,
        confidence: "high",
      },
    });

    // A known component trading below the pinned aggregate remains the
    // conservative floor even though the other component has no peg row.
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdc-circle": { currentDeviationBps: -5, priceObservedAt: NOW },
    };
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "cusd-cap")[0]?.output?.valuation).toMatchObject({
      referenceAssetKey: "usdc-circle",
      unitValueUsd: 0.9995,
      sourceId: "report-cards-peg-summary",
      confidence: "medium",
    });
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
      outputUnitValueUsd: 0.95,
      outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market",
      outputUnitValueObservedAt: NOW,
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
          capabilityMatrixVersion: "p4a.9",
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
      "usdf-falcon": { pegCurrency: "USD", currentDeviationBps: -12, priceObservedAt: NOW },
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
            expectedUnitValueUsd: 1,
            sourceId: "report-cards-peg-summary",
          }),
        }),
      }),
    ]);
  });

  it("uses a source-bound exact DEX output reference when peg and NAV valuation are unavailable", () => {
    const fixedInput = fixedInputStub(undefined);
    const route: ExitRouteObservation = {
      routeId: "dex:scrvusd-curve:dl:ethereum%3Ausdaf-output",
      routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
      requestedNotionalUsd: 1_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 31_206.39,
      completionRatio: 0.03120639,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdaf-asymmetry"] },
      outputUnitValueUsd: 0.9975,
      outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market",
      outputUnitValueObservedAt: NOW - 30,
      evidenceKind: "reserve-based-amm-simulation",
      confidence: "high",
      scoreEligible: true,
      observedAt: NOW,
      freshnessSeconds: 0,
      commonModeKeys: ["chain:ethereum", "protocol:curve"],
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "scrvusd-curve": singleObservationDexLiquidity(route),
    };
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdaf-asymmetry": {
        pegCurrency: "USD",
        currentDeviationBps: null,
        pegScore: 75,
        activeDepeg: false,
        eventCount: 103,
        worstDeviationBps: -223,
      },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "scrvusd-curve")[0]?.output?.valuation).toMatchObject({
      basis: "price",
      referenceAssetKey: "usdaf-asymmetry",
      unitValueUsd: 0.9975,
      expectedUnitValueUsd: 1,
      sourceId: "dex-amm-output-reference:curve:tracked-market",
      observedAtSec: NOW - 30,
      confidence: "high",
    });

    (route as { outputUnitValueObservedAt: number }).outputUnitValueObservedAt = NOW + 61;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "scrvusd-curve")[0]?.output?.valuation).toBeNull();
    (route as { outputUnitValueObservedAt: number }).outputUnitValueObservedAt = NOW - 30;

    // The raw DEX price alone cannot establish the expected value of a non-USD
    // peg. Without an authoritative reference the output remains unvalued.
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdaf-asymmetry": {
        pegCurrency: "EUR",
        currentDeviationBps: null,
        pegReference: null,
      },
    };
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "scrvusd-curve")[0]?.output?.valuation).toBeNull();

    (route as { outputUnitValueUsd: number }).outputUnitValueUsd = 1.1583;
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdaf-asymmetry": {
        pegCurrency: "EUR",
        currentDeviationBps: null,
        pegReference: {
          valueUsd: 1.17,
          source: "fx",
          contributorCount: 1,
          asOf: NOW - 60,
        },
      },
    };
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "scrvusd-curve")[0]?.output?.valuation).toMatchObject({
      unitValueUsd: 1.1583,
      expectedUnitValueUsd: 1.17,
      sourceId: "dex-amm-output-reference:curve:tracked-market",
    });
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
      "asset-input": singleObservationDexLiquidity(route),
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
    const withObservation = makeSupplyFullRedemption();
    const derived = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(withObservation), "usdc-circle")[0]!;
    withObservation.capacityProfile = {
      ...withObservation.capacityProfile!,
      exitRouteObservations: [derived.observation],
    };
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(withObservation), "usdc-circle")).toEqual([]);
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(undefined), "usdc-circle")).toEqual([]);
  });
});

describe("buildSafetyScoreV9RetainedRoutes composed DEX exits", () => {
  it("composes M's reviewed atomic wrap with captured wM market depth", () => {
    const fixedInput = fixedInputStub(undefined);
    const source: ExitRouteObservation = {
      routeId: "dex:wm-m0:uniswap-v3:wm-usdc",
      routeFamily: "dex-amm",
      scope: {
        kind: "chain-contract",
        chain: "ethereum",
        contractOrPoolId: "0x970a7749ecaa4394c8b2bf5f2471f41fd6b79288",
        protocol: "uniswap-v3",
      },
      requestedNotionalUsd: 1_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 1_000_000,
      completionRatio: 1,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      evidenceKind: "measured-executable-depth",
      adapterProfileId: "uniswap-v3-quoter",
      executionCostBps: 1.6,
      confidence: "high",
      scoreEligible: true,
      observedAt: NOW,
      freshnessSeconds: 0,
      commonModeKeys: ["chain:ethereum", "protocol:uniswap-v3"],
      capacityCurve: [
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          executableUsd: 1_000_000,
          completionRatio: 1,
          executionCostBps: 1.6,
        },
      ],
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "wm-m0": { exitRouteObservations: [source] },
    };
    (fixedInput as { pegDataById: Record<string, unknown> }).pegDataById = {
      "usdc-circle": { currentDeviationBps: 0, priceObservedAt: NOW },
    };

    const retained = buildSafetyScoreV9RetainedRoutes(fixedInput, "m-m0");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      lane: "dex",
      observation: {
        routeId: `composed:m-m0:${source.routeId}`,
        executableUsd: 1_000_000,
        output: { trackedAssetIds: ["usdc-circle"] },
      },
    });
    expect(source.routeId).toBe("dex:wm-m0:uniswap-v3:wm-usdc");

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "m-m0")).toEqual([
      expect.objectContaining({
        lane: "dex",
        routeId: `composed:m-m0:${source.routeId}`,
        holderAccess: "permissionless",
        settlementModel: "atomic",
        executionCosts: [
          {
            requestedNotionalUsd: 1_000_000,
            maxCostBps: 200,
            executionCostBps: 1.6,
          },
        ],
        physicalResourceKeys: [
          "pool:ethereum:0x970a7749ecaa4394c8b2bf5f2471f41fd6b79288",
          "wrapper:ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291",
        ],
        failureDomains: [
          {
            kind: "redemption-rail",
            key: "wrapper:ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291",
          },
        ],
      }),
    ]);
  });
});

describe("buildDexRouteReview model-confidence derivation", () => {
  function dexObservation(
    evidenceKind: ExitRouteObservation["evidenceKind"],
    mature = false,
    adapterProfileId?: string,
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
      ...(adapterProfileId ? { adapterProfileId } : {}),
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
      observationWindowStartedAt: NOW - 10_900,
      observationWindowEndedAt: NOW - 10_801,
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [observation] },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      modelConfidence: "medium",
    });
  });

  it("uses the uniform three-hour measured-adapter confidence window", () => {
    const fixedInput = fixedInputStub(undefined);
    const observation = dexObservation(
      "measured-executable-depth",
      true,
      DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
    );
    observation.observationHistory = {
      ...observation.observationHistory!,
      completeProducerCycleCount: 3,
      successfulObservationCount: 3,
      consecutiveSuccessCount: 3,
      observationWindowStartedAt: NOW - 10_800,
      observationWindowEndedAt: NOW - 7_199,
    };
    (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
      "usdc-circle": { exitRouteObservations: [observation] },
    };

    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      modelConfidence: "high",
    });

    delete observation.adapterProfileId;
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "usdc-circle")[0]).toMatchObject({
      modelConfidence: "high",
    });

    observation.observationHistory = {
      ...observation.observationHistory!,
      observationWindowStartedAt: NOW - 10_900,
      observationWindowEndedAt: NOW - 10_801,
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
