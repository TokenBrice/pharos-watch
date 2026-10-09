import { describe, expect, it, vi } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type * as BackstopConfigs from "@shared/lib/redemption-backstop-configs";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9/extension-routes";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";

const NOW = Date.UTC(2026, 9, 1, 18) / 1_000;
const REVIEW_MAX_AGE_SEC = 365 * 24 * 60 * 60;

const { RESOLVED_OUTPUTS, FIXTURE_CONFIGS } = vi.hoisted(() => {
  const outputs = {
    "fxd-fathom": ["usdt-tether"],
    "iusd-indigo-protocol": ["usdm-moneta", "usdc-circle"],
  } as const;
  const configs: Record<string, RedemptionBackstopConfig> = Object.fromEntries(
    Object.entries(outputs).map(([assetId, outputAssets]) => [assetId, {
      routeFamily: "stablecoin-redeem", accessModel: "permissionless-onchain",
      settlementModel: "atomic", executionModel: "deterministic-onchain",
      outputAssetType: outputAssets.length === 1 ? "stable-single" : "stable-basket",
      outputAssets: [...outputAssets], reviewedAt: "2026-09-30",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 100, feeDescription: "Fixture redemption fee." },
      docs: [{
        label: "Synthetic reviewed route", url: "https://example.com/redemption",
        supports: ["route", "capacity", "fees", "access", "settlement"],
      }],
    } satisfies RedemptionBackstopConfig]),
  );
  return { RESOLVED_OUTPUTS: outputs, FIXTURE_CONFIGS: configs };
});

vi.mock("@shared/lib/redemption-backstop-configs", async (importOriginal) => {
  const actual = await importOriginal<typeof BackstopConfigs>();
  return { ...actual, REDEMPTION_BACKSTOP_CONFIGS: { ...actual.REDEMPTION_BACKSTOP_CONFIGS, ...FIXTURE_CONFIGS } };
});

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
