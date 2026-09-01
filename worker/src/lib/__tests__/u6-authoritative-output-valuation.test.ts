import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";

const NOW = Date.UTC(2026, 8, 1, 18) / 1_000;
const REVIEW_MAX_AGE_SEC = 365 * 24 * 60 * 60;

const RESOLVED_OUTPUTS = {
  "fxd-fathom": ["usdt-tether"],
  "iusd-indigo-protocol": ["usdm-moneta", "usda-anzens", "usdc-circle"],
  "jusd-juicedollar": ["usdc-circle", "usdt-tether", "ctusd-citrea"],
} as const;

const ROUTE_DEPLOYMENTS = {
  "fxd-fathom": [
    ["usdt-tether", "xdc", "0xd4b5f10d61916bd6e0860144a91ac658de8a1437", 6],
  ],
  "iusd-indigo-protocol": [
    ["usdm-moneta", "cardano", "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d", 6],
    ["usda-anzens", "cardano", "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441", 6],
    ["usdc-circle", "cardano", "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378", 6],
  ],
  "jusd-juicedollar": [
    ["usdc-circle", "citrea", "0xe045e6c36cf77faa2cfb54466d71a3aef7bbe839", 6],
    ["ctusd-citrea", "citrea", "0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d", 6],
  ],
} as const;

type ResolvedAssetId = keyof typeof RESOLVED_OUTPUTS;

function redemptionEntry(assetId: ResolvedAssetId): RedemptionBackstopEntry {
  const config = getRedemptionBackstopConfig(assetId);
  if (!config?.reviewedAt) throw new Error(`Missing reviewed redemption config for ${assetId}`);
  return makeSupplyFullRedemption({
    stablecoinId: assetId,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel: "atomic",
    executionModel: config.executionModel,
    outputAssetType: config.outputAssetType,
    feeBps: 100,
    docs: {
      label: config.docs?.[0]?.label ?? "Reviewed route",
      url: config.docs?.[0]?.url ?? "https://example.com/reviewed-route",
      reviewedAt: config.reviewedAt,
    },
  });
}

function routeInput(
  entry: RedemptionBackstopEntry,
  deviations: Partial<Record<string, number>>,
  clockSec = NOW,
): ReportCardsFixedInput {
  return {
    clockSec,
    dexGenerationId: "dex:u6-fixed-replay",
    redemptionGenerationId: "redemption:u6-fixed-replay",
    dexLiqMap: {},
    redemptionBackstopMap: { [entry.stablecoinId]: entry },
    pegDataById: Object.fromEntries(
      Object.entries(deviations).map(([assetId, currentDeviationBps]) => [
        assetId,
        { currentDeviationBps, priceObservedAt: clockSec - 60 },
      ]),
    ),
  } as unknown as ReportCardsFixedInput;
}

function compileOutputState(
  assetId: ResolvedAssetId,
  review: ReturnType<typeof buildSafetyScoreV9RouteReviews>[number],
  observation: ExitRouteObservation,
  clockSec = NOW,
) {
  const fixed = makeV9FixedInput({
    assetId,
    clockSec,
    includeDexObservations: false,
    includeDexCoverage: false,
    omitPegRow: true,
  });
  const extension = makeV9Extension({ assetId, clockSec, observedAtSec: clockSec - 100 });
  extension.assets[0]!.routeReviews = [review];
  extension.assets[0]!.retainedRoutes = [
    { lane: "redemption", observation, disposition: "observed", rejection: null },
  ];
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!.exitRoutes[0]!.output;
}

describe("U6 authoritative redemption output valuation", () => {
  it("pins every resolved output to its canonical deployment and decimals", () => {
    for (const [assetId, expectedOutputs] of Object.entries(RESOLVED_OUTPUTS) as [ResolvedAssetId, readonly string[]][]) {
      expect(getRedemptionBackstopConfig(assetId)?.outputAssets).toEqual(expectedOutputs);
      expect(getRedemptionBackstopConfig(assetId)?.unresolvedOutputAssetKeys).toBeUndefined();
    }

    for (const deployments of Object.values(ROUTE_DEPLOYMENTS)) {
      for (const [assetId, chain, address, decimals] of deployments) {
        expect(TRACKED_META_BY_ID.get(assetId)?.contracts).toContainEqual({ chain, address, decimals });
      }
    }
  });

  it.each(Object.keys(RESOLVED_OUTPUTS) as ResolvedAssetId[])(
    "resolves %s through a timestamped canonical price source",
    (assetId) => {
      const entry = redemptionEntry(assetId);
      const outputs = RESOLVED_OUTPUTS[assetId];
      const deviations = Object.fromEntries(outputs.map((outputId, index) => [outputId, -(index + 1) * 5]));
      const fixed = routeInput(entry, deviations);
      const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
      expect(retained).toHaveLength(1);
      expect(retained[0]!.observation.output).toEqual({
        kind: "tracked-stablecoin",
        trackedAssetIds: [...outputs],
      });

      const review = buildSafetyScoreV9RouteReviews(fixed, assetId)[0]!;
      const weakestOutput = outputs[outputs.length - 1]!;
      expect(review.output?.valuation).toMatchObject({
        basis: "price",
        referenceAssetKey: weakestOutput,
        unitValueUsd: 1 - outputs.length * 5 / 10_000,
        expectedUnitValueUsd: 1,
        sourceId: "report-cards-peg-summary",
        observedAtSec: Date.parse(`${getRedemptionBackstopConfig(assetId)!.reviewedAt}T00:00:00.000Z`) / 1_000,
      });
      expect(compileOutputState(assetId, review, retained[0]!.observation)).toMatchObject({
        status: { observationState: "known" },
        valuation: { referenceAssetKey: weakestOutput },
      });
    },
  );

  it.each(Object.keys(RESOLVED_OUTPUTS) as ResolvedAssetId[])(
    "keeps missing and adverse %s valuations unknown and stale valuations stale",
    (assetId) => {
      const entry = redemptionEntry(assetId);
      const outputs = RESOLVED_OUTPUTS[assetId];

      const missingFixed = routeInput(entry, {});
      const missingObservation = buildSafetyScoreV9RetainedRedemptionRoutes(missingFixed, assetId)[0]!.observation;
      const missingReview = buildSafetyScoreV9RouteReviews(missingFixed, assetId)[0]!;
      expect(missingReview.output?.valuation).toBeNull();
      expect(compileOutputState(assetId, missingReview, missingObservation)).toMatchObject({
        status: { observationState: "missing" },
        valuation: null,
      });

      const adverse = Object.fromEntries(outputs.map((outputId) => [outputId, -10_000]));
      const adverseFixed = routeInput(entry, adverse);
      const adverseObservation = buildSafetyScoreV9RetainedRedemptionRoutes(adverseFixed, assetId)[0]!.observation;
      const adverseReview = buildSafetyScoreV9RouteReviews(adverseFixed, assetId)[0]!;
      expect(adverseReview.output?.valuation).toBeNull();
      expect(compileOutputState(assetId, adverseReview, adverseObservation)).toMatchObject({
        status: { observationState: "missing" },
        valuation: null,
      });

      const current = Object.fromEntries(outputs.map((outputId) => [outputId, 0]));
      const staleFixed = routeInput(entry, current);
      const staleObservation = buildSafetyScoreV9RetainedRedemptionRoutes(staleFixed, assetId)[0]!.observation;
      const staleReview = buildSafetyScoreV9RouteReviews(staleFixed, assetId)[0]!;
      staleReview.output!.valuation!.observedAtSec = NOW - REVIEW_MAX_AGE_SEC - 1;
      expect(compileOutputState(assetId, staleReview, staleObservation)).toMatchObject({
        status: { observationState: "stale" },
      });
    },
  );

  it.each(Object.keys(RESOLVED_OUTPUTS) as ResolvedAssetId[])(
    "includes %s in the fixed replay only when the non-output gates pass",
    (assetId) => {
      const passing = redemptionEntry(assetId);
      expect(buildSafetyScoreV9RetainedRedemptionRoutes(routeInput(passing, {}), assetId)).toHaveLength(1);

      for (const rejected of [
        { ...passing, routeStatus: "paused" as const },
        { ...passing, resolutionState: "missing-capacity" as const },
        { ...passing, capacityConfidence: "heuristic" as const },
      ]) {
        expect(buildSafetyScoreV9RetainedRedemptionRoutes(routeInput(rejected, {}), assetId)).toEqual([]);
      }
    },
  );
});
