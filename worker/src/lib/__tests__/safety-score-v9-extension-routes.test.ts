import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "@shared/types/measured-execution";
import {
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RetainedRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9/extension-routes";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { dexRouteObservation, withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";

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

function setPegData(fixedInput: ReportCardsFixedInput, pegDataById: Record<string, unknown>): void {
  const mutableFixedInput = fixedInput as unknown as { pegDataById: Record<string, unknown> };
  mutableFixedInput.pegDataById = pegDataById;
}

function redemptionPegFixture({
  rowOverrides,
  output,
  pegDataById,
  clockSec = NOW,
  observationClockSec,
}: {
  rowOverrides: Partial<RedemptionBackstopEntry>;
  output?: ExitRouteObservation["output"];
  pegDataById?: Record<string, unknown>;
  clockSec?: number;
  observationClockSec?: number;
}) {
  const row = makeSupplyFullRedemption(rowOverrides);
  const observationInput = fixedInputStub(row, observationClockSec ?? clockSec);
  const observation = buildSafetyScoreV9RetainedRedemptionRoutes(
    observationInput,
    row.stablecoinId,
  )[0]!.observation;
  row.capacityProfile = {
    ...row.capacityProfile!,
    exitRouteObservations: [{ ...observation, ...(output ? { output } : {}) }],
  };
  const fixedInput = fixedInputStub(row, clockSec);
  setPegData(fixedInput, pegDataById ?? {});
  return { fixedInput, row };
}

function dexPegFixture({
  assetId,
  routeOverrides,
  pegDataById = {},
}: {
  assetId: string;
  routeOverrides: Pick<ExitRouteObservation, "routeId" | "output"> & Partial<ExitRouteObservation>;
  pegDataById?: Record<string, unknown>;
}) {
  const fixedInput = fixedInputStub(undefined);
  const route = dexRouteObservation(NOW, routeOverrides);
  (fixedInput as { dexLiqMap: Record<string, unknown> }).dexLiqMap = {
    [assetId]: singleObservationDexLiquidity(route),
  };
  setPegData(fixedInput, pegDataById);
  return { fixedInput, route };
}

describe("buildSafetyScoreV9RouteReviews physical-commodity outputs", () => {
  it("values reviewed physical outputs without token-price or fiat substitution", () => {
    const id = "dgld-gold-token-sa";
    const row = makeSupplyFullRedemption({ stablecoinId: id, routeFamily: "offchain-issuer", settlementModel: "days", outputAssetType: "bluechip-collateral" });
    const fixed = fixedInputStub(row);
    fixed.pegDataById[id] = {
      pegCurrency: "GOLD",
      pegReference: { valueUsd: 10_000, usdPerTroyOunce: 5_000, source: "median", contributorCount: 4, asOf: NOW },
    } as ReportCardsFixedInput["pegDataById"][string];

    withRedemptionBackstopConfig(id, { reviewedAt: "2026-07-13" }, () => {
      expect(buildSafetyScoreV9RouteReviews(fixed, id)[0]?.output).toBeNull();
    });

    withRedemptionBackstopConfig(id, {
      reviewedAt: "2026-07-13",
      outputAssetType: "physical-commodity-delivery",
      physicalCommodityDelivery: {
        commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 1,
        deliveryTermsUnbounded: false,
        feeModel: { bps: 100, flatUsd: 100, deliveryUsd: 100 }, sameNotionalEligible: false,
      },
    }, (config) => {
      row.outputAssetType = "physical-commodity-delivery";
      const output = buildSafetyScoreV9RouteReviews(fixed, id)[0]?.output;
      expect(output).toMatchObject({
        kind: "physical-commodity-delivery", sameNotionalEligible: false,
        valuation: { basis: "commodity-delivery", expectedUnitValueUsd: 5_000 },
      });
      expect(output?.valuation?.unitValueUsd).toBeLessThan(5_000);

      config.physicalCommodityDelivery!.deliveryTermsUnbounded = true;
      const unbounded = buildSafetyScoreV9RouteReviews(fixed, id)[0]?.output;
      expect(unbounded).toMatchObject({ unboundedDeliveryCap: 55, sameNotionalEligible: false });
      expect(unbounded!.valuation!.unitValueUsd).toBeGreaterThan(output!.valuation!.unitValueUsd);

      delete fixed.pegDataById[id]!.pegReference!.usdPerTroyOunce;
      expect(buildSafetyScoreV9RouteReviews(fixed, id)[0]?.output).toBeNull();
    });
  });
});

function withV9RouteReviewTerms<T>(
  stablecoinId: string,
  terms: NonNullable<RedemptionBackstopConfig["v9RouteReviewTerms"]>,
  run: () => T,
): T {
  return withRedemptionBackstopConfig(stablecoinId, { v9RouteReviewTerms: terms }, run);
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
  const route = dexRouteObservation(V9_FIXTURE_CLOCK, {
    routeId: "dex:usdaf-asymmetry:dl:ethereum%3Apool:ethereum%3Athbill-output",
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["thbill-theo"] },
  });
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
        ...singleObservationDexLiquidity(route),
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

  it.each([
    { missingFields: ["capacity"] },
    { missingFields: ["settlement"] },
    { missingFields: ["cost"] },
    { missingFields: ["capacity", "settlement", "cost"] },
  ] as const)("projects omitted $missingFields terms as diagnostic while retaining captured terms", ({ missingFields }) => {
    const row = makeSupplyFullRedemption({ feeBps: 7 });
    const fixed = fixedInputStub(row);
    expect(buildSafetyScoreV9RouteReviews(fixed, row.stablecoinId)[0]?.coverageClass).toBe("exact-lower-bound");
    const retainedBefore = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, row.stablecoinId);
    const frozen = structuredClone(row);
    withV9RouteReviewTerms(row.stablecoinId, {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: [...missingFields],
      reviewedAt: "2026-07-01",
      rationale: "The omitted terms have no reviewed bound.",
      docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["settlement"] }],
    }, () => {
      const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, row.stablecoinId);
      const reviews = buildSafetyScoreV9RouteReviews(fixed, row.stablecoinId);
      expect(retained).toEqual(retainedBefore);
      expect(retained).toMatchObject([{ observation: { executableUsd: 5_000_000 } }]);
      expect(reviews).toMatchObject([{
        coverageClass: "diagnostic", settlementModel: "atomic", settlementSlaSec: 0,
      }]);
      expect([...reviews[0]!.executionCosts].sort((a, b) => a.requestedNotionalUsd - b.requestedNotionalUsd)).toEqual(
        [100_000, 1_000_000, 5_000_000, 25_000_000].map((requestedNotionalUsd) => ({
          requestedNotionalUsd, maxCostBps: 200, executionCostBps: 7,
        })),
      );
      expect(row).toEqual(frozen);
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
    expect([...fixedFeeReview.executionCosts].sort((a, b) => a.requestedNotionalUsd - b.requestedNotionalUsd)).toEqual(
      [100_000, 1_000_000, 5_000_000, 25_000_000].map((requestedNotionalUsd) => ({
        requestedNotionalUsd, maxCostBps: 200, executionCostBps: 25,
      })),
    );
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

  it.each([
    {
      scenario: "current review",
      clockSec: NOW,
      expectedReview: { settlementModel: "bounded-delay", settlementSlaSec: 2 * 86_400 },
      retainedHorizonSec: 14 * 86_400,
    },
    {
      scenario: "expired review",
      clockSec: Date.UTC(2027, 6, 2) / 1_000,
      expectedReview: {
        settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * 86_400,
      },
      retainedHorizonSec: null,
    },
  ] as const)(
    "projects $scenario settlement terms without widening captured bounds",
    ({ clockSec, expectedReview, retainedHorizonSec }) => {
      const row = makeSupplyFullRedemption({
        stablecoinId: "msusd-main-street", settlementModel: "days", settlementDelaySec: undefined,
      });
      const fixedInput = fixedInputStub(row, clockSec);
      withV9RouteReviewTerms(row.stablecoinId, FASTER_REVIEWED_SETTLEMENT, () => {
        expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]).toMatchObject(expectedReview);
        if (retainedHorizonSec !== null) {
          expect(buildSafetyScoreV9RetainedRedemptionRoutes(
            fixedInput, row.stablecoinId,
          )[0]?.observation.settlementHorizonSec).toBe(retainedHorizonSec);
          expect(buildSafetyScoreV9RouteReviews(
            fixedInput, row.stablecoinId,
          )[0]?.settlementHorizonSec).toBe(2 * 86_400);
        }
      });
    },
  );

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

    expect([...review.executionCosts].sort((a, b) => a.requestedNotionalUsd - b.requestedNotionalUsd)).toEqual(
      [100_000, 1_000_000, 5_000_000, 25_000_000].map((requestedNotionalUsd) => ({
        requestedNotionalUsd, maxCostBps: 200, executionCostBps: 30,
      })),
    );
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

  it.each([
    { routeStatusSource: "onchain" },
    { routeStatusSource: "protocol-api" },
  ] as const)(
    "keeps $routeStatusSource-sourced live-direct evidence scoreable",
    ({ routeStatusSource }) => {
      const row = liveDirectRow(routeStatusSource);
      expect(buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]).toMatchObject({
        lane: "redemption",
        coverageClass: "exact-lower-bound",
        modelConfidence: "high",
      });
    },
  );

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
    const { fixedInput, row } = redemptionPegFixture({
      rowOverrides: { stablecoinId: "dai-makerdao" },
      output: {
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdc-circle", "usdt-tether"],
      },
      pegDataById: {
        "usdc-circle": { currentDeviationBps: 2, priceObservedAt: NOW },
        "usdt-tether": { currentDeviationBps: -14, priceObservedAt: NOW },
      },
    });
    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!.output).toMatchObject({
      kind: "tracked-stablecoin",
      assetKeys: ["usdc-circle", "usdt-tether"],
      valuation: {
        basis: "price", referenceAssetKey: "usdt-tether",
        unitValueUsd: 1 - 14 / 10_000, confidence: "medium",
      },
    });
    setPegData(fixedInput, {
      "usdc-circle": { currentDeviationBps: 2, priceObservedAt: NOW },
    });
    expect(buildSafetyScoreV9RouteReviews(
      fixedInput, row.stablecoinId,
    )[0]!.output?.valuation).toBeNull();
  });

  it("compares non-USD basket components by value-to-expectation ratio", () => {
    const { fixedInput, row } = redemptionPegFixture({
      rowOverrides: { stablecoinId: "dai-makerdao" },
      output: {
        kind: "tracked-stablecoin",
        trackedAssetIds: ["thbill-theo", "usdt-tether"],
      },
      pegDataById: {
        "usdt-tether": { currentDeviationBps: -14, priceObservedAt: NOW },
      },
    });
    fixedInput.navPriceById = {
      "thbill-theo": {
        priceUsd: 0.8, sourceId: "non-usd-nav-fixture", observedAtSec: NOW, confidence: "high",
      },
    };
    expect(buildSafetyScoreV9RouteReviews(
      fixedInput, row.stablecoinId,
    )[0]?.output?.valuation).toMatchObject({
      referenceAssetKey: "usdt-tether",
      unitValueUsd: 1 - 14 / 10_000,
      expectedUnitValueUsd: 1,
    });
  });

  it("preserves USD0 mixed-collateral identities through the reviewed route output", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "usd0-usual",
      routeFamily: "stablecoin-redeem",
      outputAssetType: "mixed-collateral",
    });
    const derived = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInputStub(row), row.stablecoinId)[0]!;
    row.capacityProfile = {
      ...row.capacityProfile!,
      exitRouteObservations: [derived.observation],
    };

    const review = buildSafetyScoreV9RouteReviews(fixedInputStub(row), row.stablecoinId)[0]!;
    expect(review.output).toMatchObject({
      kind: "collateral",
      assetKeys: ["asset:m", "asset:ustbl", "asset:usyc"],
      valuation: {
        referenceAssetKey: "asset:m",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        sourceId: "report-cards-dex-usd-normalized",
      },
    });
  });


  it.each([
    { clockSec: Date.UTC(2026, 6, 13, 12) / 1_000, expectedResponsibility: undefined },
    { clockSec: Date.UTC(2026, 6, 27, 12) / 1_000, expectedResponsibility: undefined },
    { clockSec: Date.UTC(2026, 6, 28, 0, 0, 1) / 1_000, expectedResponsibility: "producer-failed" },
  ] as const)(
    "projects unresolved-output ownership at $clockSec",
    ({ clockSec, expectedResponsibility }) => {
      const { fixedInput, row } = redemptionPegFixture({
        rowOverrides: {
          stablecoinId: "dusd-dtrinity",
          routeFamily: "stablecoin-redeem",
          accessModel: "permissionless-onchain",
          executionModel: "deterministic-basket",
          outputAssetType: "stable-basket",
        },
        clockSec,
        observationClockSec: Date.UTC(2026, 6, 13, 12) / 1_000,
      });
      expect(buildSafetyScoreV9RouteReviews(
        fixedInput, row.stablecoinId,
      )[0]?.unresolvedOutputResponsibility).toBe(expectedResponsibility);
    },
  );

  it("prices the dTRINITY vault-bridge receipt basket through each receipt's underlying", () => {
    const pegDataById = Object.fromEntries(
      ([
        ["usdc-circle", 3], ["usdt-tether", -21], ["usds-sky", 1],
        ["susds-sky", 4], ["frxusd-frax", -2], ["sfrxusd-frax", 5],
        ["dai-makerdao", -4], ["sdai-sky", 6], ["ausd-agora", -1],
      ] as const).map(([assetId, currentDeviationBps]) => [
        assetId, { currentDeviationBps, priceObservedAt: NOW },
      ]),
    );
    const { fixedInput, row } = redemptionPegFixture({
      rowOverrides: {
        stablecoinId: "dusd-dtrinity",
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
      },
      pegDataById,
    });

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

    const { "usdt-tether": _dropped, ...withoutUnderlying } = fixedInput.pegDataById;
    setPegData(fixedInput, withoutUnderlying);
    expect(buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!.output).toBeNull();
  });

  it("leaves an unresolved basket unresolved when a leg has no reviewed conversion", () => {
    const { fixedInput, row } = redemptionPegFixture({
      rowOverrides: {
        stablecoinId: "dllr-sovryn",
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
      },
      pegDataById: {
        "doc-money-on-chain": { currentDeviationBps: -5, priceObservedAt: NOW },
      },
      clockSec: Date.UTC(2026, 6, 28, 0, 0, 1) / 1_000,
    });
    const review = buildSafetyScoreV9RouteReviews(fixedInput, row.stablecoinId)[0]!;
    expect(review.output).toBeNull();
    expect(review.unresolvedOutputResponsibility).toBe("producer-failed");
  });

  it("admits dEURO's source-bound nine-member EUR output valuation without calling it fiat", () => {
    const row = makeSupplyFullRedemption({
      stablecoinId: "deuro-deuro", routeFamily: "collateral-redeem",
      accessModel: "permissionless-onchain", executionModel: "deterministic-basket",
      outputAssetType: "stable-basket", feeBps: 0,
    });
    const baseObservation = buildSafetyScoreV9RetainedRedemptionRoutes(
      fixedInputStub(row), row.stablecoinId,
    )[0]!.observation;
    const assetKeys = [
      "asset:eura", "asset:eure-legacy-ethereum", "asset:eurt", "asset:veur",
      "eurc-circle", "euri-banking-circle", "europ-schuman", "eurr-stablr", "eurs-stasis",
    ];
    row.capacityConfidence = "live-direct";
    row.capacityKind = "live-direct-bounded";
    row.modelConfidence = "high";
    row.capacityProfile = {
      ...row.capacityProfile!,
      scoringUsd: 500_000,
      scoringHorizon: "immediate",
      exitRouteObservations: [{
        ...baseObservation,
        output: {
          kind: "unresolved-basket",
          assetKeys,
          basketWeights: assetKeys.map((assetId, index) => ({ assetId, weight: index === 4 ? 1 : 0 })),
        },
        routeFamily: "protocol-redemption",
        evidenceKind: "onchain-contract-state",
        confidence: "high",
        executionCostBps: 0,
        outputUnitValueUsd: 1.15,
        outputExpectedUnitValueUsd: 1.15,
        outputUnitValueSourceId: "collateral-positions-api:deuro-bridge-basket:test",
        outputUnitValueObservedAt: NOW,
        allInCostBps: 0,
        scoreEligible: true,
        observedAt: NOW,
        freshnessSeconds: 0,
      }],
    };
    expect(buildSafetyScoreV9RouteReviews(
      fixedInputStub(row), row.stablecoinId,
    )[0]?.output).toMatchObject({
      kind: "basket",
      assetKeys,
      basketWeights: [{ assetKey: "eurc-circle", weight: 1 }],
      valuation: {
        basis: "price", unitValueUsd: 1.15, expectedUnitValueUsd: 1.15,
        sourceId: "collateral-positions-api:deuro-bridge-basket:test", confidence: "high",
      },
    });
  });

  it.each([
    {
      stablecoinId: "srusd-reservoir",
      outputAssetId: "usdc-circle",
      rowOverrides: {},
      pegDataById: { "usdc-circle": { currentDeviationBps: -3, priceObservedAt: NOW } },
      expectedUnitValueUsd: 0.9997,
    },
    {
      stablecoinId: "wsrusd-reservoir",
      outputAssetId: "usdc-circle",
      rowOverrides: {},
      pegDataById: { "usdc-circle": { currentDeviationBps: -3, priceObservedAt: NOW } },
      expectedUnitValueUsd: 0.9997,
    },
    {
      stablecoinId: "zys-zephyr-protocol",
      outputAssetId: "zsd-zephyr-protocol",
      rowOverrides: { outputAssetType: "stable-single" as const },
      pegDataById: {
        "zsd-zephyr-protocol": {
          currentDeviationBps: null, pegScore: 100, activeDepeg: false,
          eventCount: 0, worstDeviationBps: null,
        },
      },
      expectedUnitValueUsd: 1,
    },
  ] as const)(
    "values $stablecoinId through its tracked $outputAssetId output",
    ({ stablecoinId, outputAssetId, rowOverrides, pegDataById, expectedUnitValueUsd }) => {
      const { fixedInput } = redemptionPegFixture({
        rowOverrides: {
          stablecoinId, routeFamily: "stablecoin-redeem",
          accessModel: "permissionless-onchain", holderEligibility: "any-holder", ...rowOverrides,
        },
        output: { kind: "tracked-stablecoin", trackedAssetIds: [outputAssetId] },
        pegDataById,
      });
      expect(buildSafetyScoreV9RouteReviews(fixedInput, stablecoinId)[0]?.output).toMatchObject({
        kind: "tracked-stablecoin",
        assetKeys: [outputAssetId],
        valuation: {
          basis: "price",
          referenceAssetKey: outputAssetId,
          unitValueUsd: expectedUnitValueUsd,
          expectedUnitValueUsd: 1,
          sourceId: "report-cards-peg-summary",
        },
      });
    },
  );

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
    const { fixedInput, route } = dexPegFixture({
      assetId: "asset-input",
      routeOverrides: {
        routeId: "dex:asset-input:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool:ethereum%3A0xfa2b947eec368f42195f24f36d2af29f7c24cec2",
        output: {
          kind: "tracked-stablecoin",
          trackedAssetIds: ["usdf-falcon"],
          assetKeys: ["ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2"],
        },
        outputUnitValueUsd: 0.95,
        outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market",
        outputUnitValueObservedAt: NOW,
      },
      pegDataById: {
        "usdf-falcon": { pegCurrency: "USD", currentDeviationBps: -12, priceObservedAt: NOW },
      },
    });
    expect(buildSafetyScoreV9RouteReviews(fixedInput, "asset-input")).toEqual([
      expect.objectContaining({
        lane: "dex", routeId: route.routeId, modelConfidence: "medium", coverageClass: "exact-complete",
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
    const { fixedInput, route } = dexPegFixture({
      assetId: "scrvusd-curve",
      routeOverrides: {
        routeId: "dex:scrvusd-curve:dl:ethereum%3Ausdaf-output",
        executableUsd: 31_206.39,
        completionRatio: 0.03120639,
        output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdaf-asymmetry"] },
        outputUnitValueUsd: 0.9975,
        outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market",
        outputUnitValueObservedAt: NOW - 30,
      },
      pegDataById: {
        "usdaf-asymmetry": {
          pegCurrency: "USD", currentDeviationBps: null, pegScore: 75,
          activeDepeg: false, eventCount: 103, worstDeviationBps: -223,
        },
      },
    });
    const outputValuation = () =>
      buildSafetyScoreV9RouteReviews(fixedInput, "scrvusd-curve")[0]?.output?.valuation;
    expect(outputValuation()).toMatchObject({
      basis: "price",
      referenceAssetKey: "usdaf-asymmetry",
      unitValueUsd: 0.9975,
      expectedUnitValueUsd: 1,
      sourceId: "dex-amm-output-reference:curve:tracked-market",
      observedAtSec: NOW - 30,
      confidence: "high",
    });
    route.outputUnitValueObservedAt = NOW + 61;
    expect(outputValuation()).toBeNull();
    route.outputUnitValueObservedAt = NOW - 30;
    setPegData(fixedInput, {
      "usdaf-asymmetry": { pegCurrency: "EUR", currentDeviationBps: null, pegReference: null },
    });
    expect(outputValuation()).toBeNull();
    route.outputUnitValueUsd = 1.1583;
    setPegData(fixedInput, {
      "usdaf-asymmetry": {
        pegCurrency: "EUR",
        currentDeviationBps: null,
        pegReference: { valueUsd: 1.17, source: "fx", contributorCount: 1, asOf: NOW - 60 },
      },
    });
    expect(outputValuation()).toMatchObject({
      unitValueUsd: 1.1583,
      expectedUnitValueUsd: 1.17,
      sourceId: "dex-amm-output-reference:curve:tracked-market",
    });
  });

  it.each([
    { outputPinSource: "source-token-usd" },
    { outputPinSource: "peg-reference" },
    { outputPinSource: "pool-implied" },
  ] as const)(
    "rejects persisted $outputPinSource DEX output pins without independent valuation",
    ({ outputPinSource }) => {
      const { fixedInput, route } = dexPegFixture({
        assetId: "asset-input",
        routeOverrides: {
          routeId: "dex:asset-input:dl:ethereum%3Apool:ethereum%3Aoutput",
          output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
          outputUnitValueUsd: 1,
          outputUnitValueSourceId: `dex-amm-output-reference:curve:${outputPinSource}`,
          outputUnitValueObservedAt: NOW,
        },
        pegDataById: { "usdt-tether": { pegCurrency: "USD", currentDeviationBps: null } },
      });
      expect(buildSafetyScoreV9RouteReviews(
        fixedInput, "asset-input",
      )[0]?.output?.valuation).toBeNull();
      route.outputUnitValueSourceId = "dex-amm-output-reference:curve:tracked-market";
      expect(buildSafetyScoreV9RouteReviews(
        fixedInput, "asset-input",
      )[0]?.output?.valuation).toMatchObject({ unitValueUsd: 1 });
    },
  );

  it("values a NAV output from the captured NAV price without creating a peg valuation", () => {
    const { fixedInput } = dexPegFixture({
      assetId: "asset-input",
      routeOverrides: {
        routeId: "dex:asset-input:dl:ethereum%3Apool:ethereum%3Anav-output",
        output: { kind: "tracked-stablecoin", trackedAssetIds: ["thbill-theo"] },
      },
    });
    fixedInput.navPriceById = {
      "thbill-theo": {
        priceUsd: 1.0188, sourceId: "defillama-contract", observedAtSec: NOW, confidence: "high",
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
    const observation = dexRouteObservation(NOW, {
      routeId: `dex:usdc-circle:dl:ethereum%3Apool:${evidenceKind}`,
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: `pool-${evidenceKind}`, protocol: "curve" },
      maxCostBps: 50,
      executableUsd: 950_000,
      completionRatio: 0.95,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind,
      ...(adapterProfileId ? { adapterProfileId } : {}),
    });
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
    { evidenceKind: "reserve-based-amm-simulation" },
    { evidenceKind: "direct-orderbook-depth" },
    { evidenceKind: "generic-tvl-proxy" },
    { evidenceKind: "synthetic-or-fallback" },
    { evidenceKind: "unobserved" },
  ] as const)("keeps $evidenceKind evidence at medium model confidence", ({ evidenceKind }) => {
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
