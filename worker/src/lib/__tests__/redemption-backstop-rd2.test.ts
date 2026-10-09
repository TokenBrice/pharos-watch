import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "@shared/lib/redemption-backstops";
import { resolveFeeConfidence, resolveFeeModelKind } from "@shared/lib/redemption-backstop-confidence";
import { evaluateV9Exit, projectV9ExitEvaluationRoute } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { resolveReviewedRedemptionSettlementDelay } from "@shared/lib/redemption-backstop-configs/settlement";
import { resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { buildRedemptionExitRouteObservation, deriveSupplyModelExitRouteObservation } from "../redemption-exit-route-observations";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { makeV9FixedInput, makeV9Extension } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

const now = Date.UTC(2026, 9, 10, 12) / 1_000;
const supplyUsd = 100_000_000;
const db = {} as D1Database;
const eventualClaims = [
  ["brsrv-blackrock", "allowlisted"],
  ["cumiu-chinaamc", "institutional-eligible"],
  ["chfsafo-spiko", "institutional-eligible"],
  ["eurw-newrails", "institutional-eligible"],
  ["usdsm-stable-mint", "institutional-eligible"],
  ["usdu-universal", "allowlisted"],
] as const;

function fixedInput(row: RedemptionBackstopEntry): ReportCardsFixedInput {
  return {
    clockSec: now,
    dexGenerationId: "dex-liquidity-rd2",
    redemptionGenerationId: "redemption-backstops-rd2",
    dexLiqMap: {},
    redemptionBackstopMap: { [row.stablecoinId]: row },
    pegDataById: {},
  } as unknown as ReportCardsFixedInput;
}

async function resolve(id: string, supply: number | null = supplyUsd) {
  const config = getRedemptionBackstopConfig(id)!;
  const capacity = await resolveRedemptionCapacity(db, id, config.capacityModel, supply, now);
  const row = makeSupplyFullRedemption({
    stablecoinId: id,
    updatedAt: now,
    ...capacity,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    holderEligibility: config.holderEligibility,
    settlementModel: config.settlementModel,
    executionModel: config.executionModel,
    outputAssetType: config.outputAssetType,
    feeBps: resolveV9RedemptionRouteCostBpsAtNotional(config, 5_000_000),
    feeConfidence: resolveFeeConfidence(config.costModel),
    feeModelKind: resolveFeeModelKind(config.costModel),
    capacityProfile: capacity.capacityProfile && { ...capacity.capacityProfile, modeledExitSizeUsd: 5_000_000 },
    docs: { ...config.docs![0], reviewedAt: config.reviewedAt },
  });
  return { config, capacity, row };
}

function assertConsumerGaps(row: RedemptionBackstopEntry) {
  const assetId = row.stablecoinId;
  const draft = makeV9FixedInput({ assetId, clockSec: now });
  draft.redemptionBackstopMap = { [assetId]: row };
  draft.redemptionStale = false;
  draft.redemptionGenerationId = "redemption:rd2";
  draft.inputFreshness.redemptionBackstops = { updatedAt: now, ageSeconds: 0, stale: false };
  const fixed = rebuildFixed(draft);
  const extension = structuredClone(makeV9Extension({ assetId, clockSec: now, registryFingerprint: fixed.registryFingerprint }));
  extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
  extension.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
  const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
  const redemptionRoutes = asset.exitRoutes.filter((route) => route.lane === "redemption");
  expect(redemptionRoutes).toHaveLength(1);
  for (const factor of ["capacity", "settlement", "cost"] as const) {
    expect(redemptionRoutes[0]!.factorStatuses[factor]?.observationState).toBe("missing");
  }
  const evaluated = evaluateV9Exit({
    circulatingUsd: asset.supply.circulatingUsd,
    routes: redemptionRoutes.map(projectV9ExitEvaluationRoute),
  }, V9_CANDIDATE_POLICY_V1);
  expect(evaluated.primaryRouteKey).toBeNull();
  expect(evaluated.diversificationRouteKey).toBeNull();
}

describe("RD2 legal entitlement remains eventual diagnostic evidence", () => {
  it.each(eventualClaims)("documents %s without immediate/scoring promotion or broader holder access", async (id, holderAccess) => {
    const { capacity, row } = await resolve(id);
    expect(capacity).toMatchObject({
      eventualCapacityUsd: supplyUsd,
      eventualCapacityRatio: 1,
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      capacityConfidence: "documented-bound",
      capacitySemantics: "eventual-only",
      capacityProfile: { eventualUsd: supplyUsd, immediateUsd: null, scoringUsd: null, scoringHorizon: "eventual" },
    });
    const retained = buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput(row), id);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.observation).toMatchObject({ routeFamily: "eventual-redemption", scoreEligible: false });
    expect(buildSafetyScoreV9RouteReviews(fixedInput(row), id)).toMatchObject([
      { coverageClass: "diagnostic", capacityScoringHorizon: "eventual", holderAccess, settlementSlaSec: null },
    ]);
    assertConsumerGaps(row);
    for (const routeStatus of ["suspended", "unknown"] as const) {
      expect(deriveSupplyModelExitRouteObservation({ ...row, routeStatus }, now)).toBeNull();
    }
  });

  it.each(eventualClaims)("leaves %s missing-cache instead of inventing zero when supply is unavailable", async (id) => {
    const { capacity, row } = await resolve(id, null);
    expect(capacity).toMatchObject({ resolutionState: "missing-cache", immediateCapacityUsd: null, scoringCapacityUsd: null });
    expect(capacity.eventualCapacityUsd).toBeUndefined();
    expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput(row), id)).toEqual([]);
  });

  it.each(["xgz-goldzip", "zaru-blocktower", "stbt-matrixdock", "gldy-streamex"])(
    "does not convert %s supply/backing/token quantities into executable or eventual USD", async (id) => {
      for (const supply of [null, supplyUsd]) {
        const { capacity, row } = await resolve(id, supply);
        expect(capacity).toMatchObject({
          resolutionState: "missing-capacity", immediateCapacityUsd: null, immediateCapacityRatio: null,
          scoringCapacityUsd: null, scoringCapacityRatio: null, eventualCapacityUsd: null, eventualCapacityRatio: null,
        });
        expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput(row), id)).toEqual([]);
      }
    },
  );

  it.each(["gldon-ondo", "pyusdx-moonpay", "filqa-fidelity-international", "fiusd-sygnum", "uscc-superstate", "oned-gennius", "umint-ubs", "mxnt-tether"])(
    "does not promote %s from conditional, historical, different-product or account-conversion context", async (id) => {
      const { capacity, row } = await resolve(id);
      expect(capacity).toMatchObject({ capacityConfidence: "heuristic", immediateCapacityUsd: null, scoringCapacityUsd: null });
      expect(buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput(row), id)).toEqual([]);
    },
  );
});

describe("RD2 issuer-fee and output boundaries", () => {
  // A captured positive capacity point is deliberately retained as diagnostic evidence.
  // It cannot erase current missing-factor reviews or certify an alternative payout.
  async function captured(id: string) {
    const { config, row } = await resolve(id);
    if (!row.capacityProfile) throw new Error("Expected configured route capacity profile");
    const observation = buildRedemptionExitRouteObservation({
      stablecoinId: id, config, capacityProfile: { scoringUsd: supplyUsd, scoringHorizon: "immediate", capacityProfileConfidence: row.capacityConfidence, modeledExitSizeUsd: 5_000_000 },
      scoringCapacityUsd: supplyUsd, supplyUsd, routeStatus: "open", resolutionState: "resolved", sourceMode: "static",
      capacityConfidence: row.capacityConfidence, resolvedFeeBps: row.feeBps, now,
    })!;
    const capturedRow = { ...row, capacityProfile: { ...row.capacityProfile, exitRouteObservations: [observation] } };
    assertConsumerGaps(capturedRow);
    return { config, observation, reviews: buildSafetyScoreV9RouteReviews(fixedInput(capturedRow), id) };
  }

  it("publishes MoonPay's zero issuer fee without an all-in cost bound or downstream-holder entitlement", async () => {
    const { config, observation, reviews } = await captured("pyusdx-moonpay");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(0);
    expect(observation).toMatchObject({ scoreEligible: false, output: { kind: "tracked-stablecoin", trackedAssetIds: ["pyusd-paypal"] } });
    expect(reviews).toMatchObject([{ holderAccess: "allowlisted", coverageClass: "diagnostic", settlementSlaSec: null }]);
  });

  it("does not turn GLDY's secondary-source fee or secondary liquidity into a funded USD redemption", async () => {
    const { config, observation, reviews } = await captured("gldy-streamex");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
    expect(observation).toMatchObject({
      scoreEligible: false,
      output: { kind: "unresolved-asset", assetKeys: ["fiat:USD", "stablecoin:identity-unspecified", "physical:XAU"] },
    });
    expect(reviews).toMatchObject([{ coverageClass: "diagnostic", settlementSlaSec: null }]);
  });

  it("keeps GLDon's instant alternatives separate from the standard USDC/USDT investor put", async () => {
    const { config, observation, reviews } = await captured("gldon-ondo");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
    // RD5-03 withholds completed-settlement scalars despite the diagnostic immediate category.
    expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, now)).toBeUndefined();
    expect(observation).toMatchObject({ scoreEligible: false, output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdon-ondo"] } });
    expect(observation.output).not.toHaveProperty("basketWeights");
    expect(reviews).toMatchObject([{ holderAccess: "institutional-eligible", coverageClass: "diagnostic", minRedeemUsd: 1 }]);
  });

  it("retains GoldZip physical delivery without inventing USD proceeds or free delivery", async () => {
    const { observation, reviews } = await captured("xgz-goldzip");
    expect(observation).toMatchObject({
      scoreEligible: false, output: { kind: "physical-commodity-delivery", assetKeys: ["commodity:xau"], sameNotionalEligible: false },
    });
    expect(reviews).toMatchObject([{ coverageClass: "diagnostic", settlementSlaSec: null }]);
  });
});
