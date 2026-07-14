import { describe, expect, it } from "vitest";
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
    expect(reviews[0]).toMatchObject({ settlementModel: "atomic", settlementSlaSec: 0 });
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
