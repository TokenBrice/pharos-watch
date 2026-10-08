import { describe, expect, it } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { resolveReviewedRouteSuspension } from "@shared/lib/redemption-route-suspension";
import { evaluateV9Exit, projectV9ExitEvaluationRoute } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { RedemptionRouteSuspension } from "@shared/types/redemption";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";

const ID = "usdc-circle";
const CLOCK = Date.UTC(2026, 9, 2, 12) / 1_000;
const suspension: RedemptionRouteSuspension = {
  routeId: `redemption:${ID}:offchain-issuer`, channel: "Legacy issuer portal",
  suspendedAt: "2026-06-30", reviewedAt: "2026-07-01", reviewer: "reviewer",
  reason: "Only the legacy portal suspended exchanges; independent channels remain available for their own review.",
  sources: [{ url: "https://example.com/notice", quote: "Legacy exchanges suspended June 30." }],
};

function compileSet(fixed: ReportCardsFixedInput) {
  const extension = makeV9Extension({ assetId: ID, clockSec: CLOCK, registryFingerprint: fixed.registryFingerprint });
  extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, ID);
  extension.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, ID);
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
}
function compile(fixed: ReportCardsFixedInput) {
  return compileSet(fixed).assets[0]!;
}
function evaluate(asset: V9AssetFactsV3) {
  return evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd,
    portfolioStatus: "reviewed-complete", routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
  }, V9_CANDIDATE_POLICY_V1);
}

describe("reviewed exact-channel suspension", () => {
  it("withholds captured positive capacity only on the named rail and leaves DEX and another issuer channel unchanged", () => {
    const base = makeV9FixedInput({ assetId: ID, clockSec: CLOCK });
    const row = makeSupplyFullRedemption({ stablecoinId: ID, updatedAt: CLOCK - 100 });
    base.redemptionGenerationId = "redemption:suspension-fixture";
    base.redemptionStale = false;
    base.inputFreshness.redemptionBackstops = { updatedAt: row.updatedAt, ageSeconds: CLOCK - row.updatedAt, stale: false };
    const withRow = rebuildFixed({ ...base, redemptionBackstopMap: { [ID]: row } });
    const observation = buildSafetyScoreV9RetainedRedemptionRoutes(withRow, ID)[0]!.observation;
    row.capacityProfile = { ...row.capacityProfile!, exitRouteObservations: [observation, {
      ...observation, routeId: "redemption:successor-channel", scope: { kind: "issuer", issuerId: "successor" },
      commonModeKeys: ["issuer:successor"],
    }] };
    const fixed = rebuildFixed({ ...base, redemptionBackstopMap: { [ID]: row } });
    const before = compile(fixed);
    const frozen = structuredClone(fixed);
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: suspension }, () => {
      const review = buildSafetyScoreV9RouteReviews(fixed, ID).find((item) => item.routeId === suspension.routeId)!;
      expect(review).toMatchObject({ coverageClass: "diagnostic", routeSuspension: suspension });
      const after = compile(fixed);
      const withdrawn = after.exitRoutes.find((item) => item.routeId === suspension.routeId)!;
      expect(withdrawn).toMatchObject({ scoreEligible: false, capacityCurve: [], request: null, routeSuspension: suspension });
      expect(after.exitRoutes.filter((item) => !item.routeSuspension)).toEqual(
        before.exitRoutes.filter((item) => item.routeId !== suspension.routeId),
      );
      const result = evaluate(after);
      const trace = result.routes.find((item) => item.routeKey === withdrawn.routeKey)!;
      expect(trace).toMatchObject({ included: false, score: null, capacityPoint: null, routeSuspension: suspension });
      const independentlyEvaluated = evaluate({ ...before, exitRoutes: before.exitRoutes.filter((item) => item.routeId !== suspension.routeId) });
      expect(result.score).toBe(independentlyEvaluated.score);
      expect(result.primaryRouteKey).toBe(independentlyEvaluated.primaryRouteKey);
      expect(result.reasons).toEqual(independentlyEvaluated.reasons);
      expect(fixed).toEqual(frozen);
    });
  });

  it("retains public diagnostic evidence without a capture row and never infers measured total failure from suspension alone", () => {
    const fixed = makeV9FixedInput({ assetId: ID, clockSec: CLOCK, includeDexObservations: false,
      dexOverrides: { exitRouteObservationCoverage: { status: "populated", capabilityMatrixVersion: "p4a.9",
        retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0,
        unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {} } },
    });
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: suspension }, () => {
      const asset = compile(fixed);
      const result = evaluate(asset);
      expect(result.primaryRouteKey).toBeNull();
      expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
      expect(result.reasons).toEqual(["missing-same-notional-route"]);
      expect(result.reasons).not.toContain("no-viable-exit-path");
      expect(result.routes[0]).toMatchObject({ included: false, capacityPoint: null, routeSuspension: suspension });
      expect(asset.gaps.filter((gap) => gap.gapId.includes(":suspended"))).toEqual([
        expect.objectContaining({ responsibility: "unresearched", causeProof: expect.objectContaining({ cause: "U" }) }),
      ]);
      const published = evaluateV9FactSet(compileSet(fixed), V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(published.trace.finalGrade).not.toBe("F");
      expect(published.trace.adverseAttribution).toEqual([]);
    });
  });

  it("cannot turn an immaterial DEX measurement plus a suspended channel into whole-token adverse F", () => {
    const base = makeV9FixedInput({ assetId: ID, clockSec: CLOCK });
    const dex = base.dexLiqMap[ID]!;
    const observations = dex.exitRouteObservations!.map((observation) => ({
      ...observation, executableUsd: 999.9, completionRatio: 999.9 / observation.requestedNotionalUsd,
      capacityCurve: observation.capacityCurve!.map((point) => ({
        ...point, executableUsd: 999.9, completionRatio: 999.9 / point.requestedNotionalUsd,
      })),
    }));
    const fixed = rebuildFixed({ ...base, dexLiqMap: { [ID]: { ...dex, exitRouteObservations: observations } } });
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: suspension }, () => {
      const compiled = compileSet(fixed);
      const published = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(published.trace.finalGrade).not.toBe("F");
      expect(published.trace.adverseAttribution).toEqual([]);
      expect(published.exit.reasons).not.toContain("no-viable-exit-path");
      expect(published.exit.routes.find((route) => !route.routeSuspension)).toMatchObject({ score: 0, included: true });
    });
  });

  it("does not admit future reviews or apply the notice to another route", () => {
    const config = { ...getRedemptionBackstopConfig(ID)!, routeStatus: "suspended" as const, routeSuspension: suspension };
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, Date.UTC(2026, 5, 30) / 1_000)).toBeUndefined();
    const reviewClock = Date.UTC(2026, 6, 1) / 1_000;
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, reviewClock - 1)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, reviewClock)).toBe(suspension);
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, reviewClock + 1)).toBe(suspension);
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, Number.NaN)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:successor-channel", CLOCK)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(null, suspension.routeId, CLOCK)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(undefined, suspension.routeId, CLOCK)).toBeUndefined();
    for (const routeStatus of ["open", "unknown"] as const) {
      expect(resolveReviewedRouteSuspension({ ...config, routeStatus, routeSuspension: undefined }, suspension.routeId, CLOCK)).toBeUndefined();
    }
  });

  it("does not close a separately reviewed physical channel when only the exchange rail is suspended", () => {
    const id = "paxg-paxos";
    const row = makeSupplyFullRedemption({ stablecoinId: id, routeStatus: "open" });
    const fixed = makeV9FixedInput({ assetId: id, clockSec: CLOCK, aggregateCirculating: { peggedUSD: 20_000_000 } });
    fixed.redemptionBackstopMap = { [id]: row };
    fixed.pegDataById[id] = {
      pegCurrency: "GOLD",
      pegReference: { valueUsd: 1_000, usdPerTroyOunce: 1_000, source: "median", contributorCount: 4, asOf: CLOCK },
    } as ReportCardsFixedInput["pegDataById"][string];
    const physicalToUsd = structuredClone(getRedemptionBackstopConfig(id)!.physicalToUsd!);
    physicalToUsd.fees = { issuerFeeBps: 0, issuerFixedUsd: 0, deliveryUsdPerLot: 0,
      insuranceBps: 0, assayUsdPerLot: 0, taxBps: 0, conversionBps: 0 };
    physicalToUsd.settlementLegs = [{ leg: "issuer-release", maximumBusinessDays: 1 }];
    withRedemptionBackstopConfig(id, { physicalToUsd, routeStatus: "suspended",
      routeSuspension: { ...suspension, routeId: `redemption:${id}:offchain-issuer` },
    }, () => {
      const before = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, id).find((route) => route.observation.physicalToUsd)!;
      expect(before.observation.physicalToUsd!.rejectionReason).toBeNull();
      row.routeStatus = "suspended";
      const after = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, id).find((route) => route.observation.physicalToUsd)!;
      expect(after).toEqual(before);
    });
  });

  it("publishes a sourced suspended standalone row with null capacity and scores, not measured zero", async () => {
    const config = { ...getRedemptionBackstopConfig(ID)!, routeStatus: "suspended" as const, routeSuspension: suspension };
    const entry = await buildRedemptionBackstopEntry(mockD1Strict([]), ID, config, 100_000_000, 60, CLOCK,
      { reserveSnapshotMetadata: null });
    expect(entry).toMatchObject({ routeStatus: "suspended", routeStatusSource: "operator-notice",
      routeStatusReason: suspension.reason, routeStatusReviewedAt: suspension.reviewedAt,
      score: null, capacityScore: null, eventualRedeemabilityScore: null, immediateCapacityUsd: null,
      immediateCapacityRatio: null, dexLiquidityScore: 60,
      capacityProfile: { scoringUsd: null, immediateUsd: null, eventualUsd: null },
    });
    expect(entry.capacityProfile?.exitRouteObservations).toBeUndefined();
    expect(entry.capsApplied).toEqual(["reviewed-route-suspension"]);
  });
});
