import { describe, expect, it } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { resolveReviewedRouteSuspension } from "@shared/lib/redemption-route-suspension";
import { evaluateV9Exit, projectV9ExitEvaluationRoute } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import type { RedemptionRouteSuspension } from "@shared/types/redemption";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { makeV9Extension, makeV9FixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension, materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9/fact-set";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { localControl, rebuildFixed } from "./safety-score-v9-fact-set.test-support";
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
  const result = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
    fixed, materializeSafetyScoreV9FactSetExtension(fixed, extension),
  );
  expect(result.quarantines).toEqual([]);
  return result.factSet;
}
function compile(fixed: ReportCardsFixedInput) {
  return compileSet(fixed).assets[0]!;
}
function evaluate(asset: V9AssetFactsV3) {
  return evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd,
    gaps: asset.gaps,
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
      expect(withdrawn.factorStatuses).toEqual({});
      expect(withdrawn.capacityEvidenceTier).toBe("unknown");
      expect(after.gaps.filter((gap) => gap.causeScope?.routeKey === withdrawn.routeKey)).toEqual([
        expect.objectContaining({ causeProof: expect.objectContaining({ cause: "D" }),
          responsibility: "measured-adverse", causeScope: expect.objectContaining({ factorKey: "suspended" }) }),
      ]);
      expect(after.exitRoutes.filter((item) => !item.routeSuspension)).toEqual(
        before.exitRoutes.filter((item) => item.routeId !== suspension.routeId),
      );
      const result = evaluate(after);
      const trace = result.routes.find((item) => item.routeKey === withdrawn.routeKey)!;
      expect(trace).toMatchObject({ included: false, score: null, capacityPoint: null, routeSuspension: suspension,
        cause: "D", scoringDisposition: "measured-adverse", causeGapIds: withdrawn.status.gapIds });
      const independentlyEvaluated = evaluate({ ...before, exitRoutes: before.exitRoutes.filter((item) => item.routeId !== suspension.routeId) });
      expect(result.score).toBe(independentlyEvaluated.score);
      expect(result.primaryRouteKey).toBe(independentlyEvaluated.primaryRouteKey);
      expect(result.reasons).toEqual(independentlyEvaluated.reasons);
      expect(fixed).toEqual(frozen);
    });
  });

  it("retains public diagnostic evidence without a capture row and never infers measured total failure from suspension alone", () => {
    const fixed = makeV9FixedInput({ assetId: ID, clockSec: CLOCK, includeDexObservations: false,
      dexOverrides: { exitRouteObservationCoverage: { status: "populated", capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
        retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0,
        unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {} } },
    });
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: suspension }, () => {
      const asset = compile(fixed);
      const result = evaluate(asset);
      expect(result.primaryRouteKey).toBeNull();
      expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit.U);
      expect(result.reasons).toEqual(["missing-same-notional-route"]);
      expect(result.reasons).not.toContain("no-viable-exit-path");
      expect(result.routes[0]).toMatchObject({ included: false, capacityPoint: null, routeSuspension: suspension });
      expect(asset.gaps.filter((gap) => gap.gapId.includes(":suspended"))).toEqual([
        expect.objectContaining({ responsibility: "measured-adverse", reasonCode: "unsupported-same-notional-route",
          causeProof: expect.objectContaining({ cause: "D" }) }),
      ]);
      const withdrawn = asset.exitRoutes[0]!;
      expect(withdrawn.factorStatuses).toEqual({});
      expect(withdrawn.capacityEvidenceTier).toBe("unknown");
      expect(asset.gaps.filter((gap) => gap.causeScope?.routeKey === withdrawn.routeKey)).toHaveLength(1);
      expect(asset.gaps.some((gap) => gap.causeScope?.routeKey === withdrawn.routeKey && gap.causeProof.cause === "U")).toBe(false);
      expect(result.routes[0]).toMatchObject({ cause: "D", scoringDisposition: "measured-adverse" });
      const adverseEvidence = asset.evidence.find((item) => item.evidenceId === withdrawn.status.evidenceRefIds[0])!;
      expect(adverseEvidence).toMatchObject({ disposition: "observed", rejection: null, url: suspension.sources[0]!.url,
        causeBinding: { assetId: ID, scope: { pillar: "exit", componentKey: "exit-route",
          routeKey: withdrawn.routeKey, factorKey: "suspended", requiredDatum: "suspended", exposureId: null },
          adverseFactId: `${ID}:route-suspension:${suspension.routeId}`, producerState: null, rejectionCode: null } });
      const published = evaluateV9FactSet(compileSet(fixed), V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(published.trace.finalGrade).not.toBe("F");
      expect(published.trace.adverseAttribution).toEqual([]);
      expect(published.exit.routes.find((route) => route.routeSuspension)).toMatchObject({
        cause: "D", scoringDisposition: "measured-adverse", included: false, score: null, capacityPoint: null,
      });
    });
  });

  it.each([
    { assetId: "vnxau-vnx", adverseMint: false, dexCapacityUsd: undefined },
    { assetId: "vnxau-vnx", adverseMint: false, dexCapacityUsd: 1_000 },
    { assetId: "usdkg-gold-dollar", adverseMint: true, dexCapacityUsd: undefined },
  ])("keeps $assetId whole-Exit uncertainty separate from the closed channel (DEX capacity $dexCapacityUsd)", ({ assetId, adverseMint, dexCapacityUsd }) => {
    const clockSec = Date.UTC(2026, 9, 11, 12) / 1_000;
    const makeSet = (includeDexObservations: boolean, executableUsd?: number) => {
      let fixed = makeV9FixedInput({ assetId, clockSec, omitLiveReserve: true, includeDexObservations,
        ...(!includeDexObservations ? {
          dexOverrides: { exitRouteObservationCoverage: { status: "populated",
            capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION, retainedPoolCount: 0,
            observationCount: 0, scoreEligibleObservationCount: 0, unsupportedPoolCount: 0,
            evidenceCounts: {}, unsupportedReasons: {} } },
        } : {}),
      });
      if (executableUsd !== undefined) {
        // A $1,000 admitted DEX observation remains submaterial against the
        // continuous $500k stress request; the issuer rail is closed.
        const dex = fixed.dexLiqMap[assetId]!;
        const observations = dex.exitRouteObservations!.map((observation) => ({
          ...observation, executableUsd, completionRatio: executableUsd / observation.requestedNotionalUsd,
          capacityCurve: observation.capacityCurve!.map((point) => ({
            ...point, executableUsd, completionRatio: executableUsd / point.requestedNotionalUsd,
          })),
        }));
        fixed = rebuildFixed({ ...fixed, dexLiqMap: { [assetId]: { ...dex, exitRouteObservations: observations } } });
      }
      const extension = makeV9Extension({ assetId, clockSec, registryFingerprint: fixed.registryFingerprint });
      const review = extension.assets[0]!;
      review.mechanismRiskReview = null;
      if (adverseMint) {
        // USDKG's retained danger is its independently measured unbounded
        // mint, not the exact-channel suspension (frozen audit attribution).
        review.controlReview = { state: "reviewed-controls", controls: [localControl({
          controlKey: "mint:known", deploymentKey: `asset:${assetId}`, controlKind: "mint",
          capabilities: ["mint"], capSemantics: { kind: "unbounded", bound: null },
          claimImpairment: "unbounded", economicLossScope: "global-claim",
          delaySec: null, keyCustody: "hsm", modulesOrGuards: "none-detected",
          failureDomains: [{ kind: "mint-control", key: "ethereum:0x4444444444444444444444444444444444444444" }],
        })] };
        review.economicControlReview!.mint = {
          ...review.economicControlReview!.mint, controlKey: "mint:known",
          status: v9Status("known", "v9.control.mint-review"),
          reconciliation: "none", supervision: "none", upgrade: { state: "immutable", controlKey: null },
        };
      }
      review.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
      review.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
      const result = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        fixed, materializeSafetyScoreV9FactSetExtension(fixed, extension),
      );
      expect(result.quarantines).toEqual([]);
      return result.factSet;
    };
    const compiled = makeSet(dexCapacityUsd !== undefined, dexCapacityUsd);
    const asset = compiled.assets[0]!;
    const censusId = `${assetId}:gap:exit-independent-route-census`;
    if (dexCapacityUsd === undefined) {
      expect(asset.gaps.find((gap) => gap.gapId === censusId)).toMatchObject({
        causeProof: { cause: "U" }, observationState: "bounded-unknown",
        path: { kind: "local-component", componentKey: "exit-routes" },
        causeScope: { pillar: "exit", componentKey: "exit-routes", factorKey: null,
          routeKey: null, exposureId: null, requiredDatum: "independent-route-census" },
      });
      expect(asset.exitStatus.gapIds).toContain(censusId);
      expect(asset.exitStatus.observationState).toBe("bounded-unknown");
    } else {
      expect(asset.gaps.some((gap) => gap.gapId === censusId)).toBe(false);
      expect(asset.exitStatus.gapIds).not.toContain(censusId);
    }
    const withdrawn = asset.exitRoutes.find((route) => route.routeSuspension)!;
    expect(withdrawn).toMatchObject({ scoreEligible: false, request: null, capacityCurve: [], factorStatuses: {} });
    expect(asset.gaps.filter((gap) => gap.causeScope?.routeKey === withdrawn.routeKey)).toEqual([
      expect.objectContaining({ causeProof: expect.objectContaining({ cause: "D" }),
        causeScope: expect.objectContaining({ factorKey: "suspended" }) }),
    ]);
    const published = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    if (dexCapacityUsd === undefined) {
      // The reviewed channel establishes the applicable Exit subject, while
      // its suspension does not establish exhaustion of independent rails.
      expect(published.scoreInput.pillars.exit.evidenceLevel).toBe("limited");
      expect(published.exit.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit.U);
    } else {
      expect(published.exit.score).toBe(0);
      expect(published.scoreInput.pillars.exit.limitingCauseGapIds ?? []).not.toContain(censusId);
    }
    expect(published.exit.reasons.includes("no-viable-exit-path")).toBe(dexCapacityUsd !== undefined);
    expect(published.scoreInput.pillars.backing.evidenceLevel).toBe("insufficient");
    if (dexCapacityUsd !== undefined) {
      const measured = asset.exitRoutes.find((route) => route.lane === "dex")!;
      expect(measured.scoreEligible).toBe(true);
      expect(measured).not.toHaveProperty("routeSuspension");
      expect(measured.capacityCurve).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestedNotionalUsd: 1_000_000, executableUsd: 1_000, completionRatio: 0.001 }),
      ]));
      expect(published.exit.stressRequest).toMatchObject({ requestedNotionalUsd: 1_000_000, rawSupplyRequestUsd: 500_000 });
      expect(published.exit.routes.find((route) => route.routeKey === measured.routeKey)).toMatchObject({
        included: true, capacityPoint: { executableUsd: 1_000 },
      });
      expect(published.exit.routes.find((route) => route.routeKey === measured.routeKey)!.score).toBe(0);
      expect(published.exit.routes.find((route) => route.routeKey === measured.routeKey)!.capsApplied)
        .toContain("immaterial-executable-capacity");
    }
    if (dexCapacityUsd !== undefined) {
      expect(published.trace.adverseAttribution).toContainEqual(expect.objectContaining({
        source: "pillar-score", responsibility: "measured-adverse",
      }));
    } else if (!adverseMint) {
      expect(published.trace.adverseAttribution).toEqual([]);
    } else {
      expect(published.trace.adverseAttribution).toEqual([
        expect.objectContaining({ source: "structural-signal", responsibility: "measured-adverse",
          path: "structural:centralized-mint:high" }),
      ]);
      expect(published.trace.finalGrade).not.toBe("NR");
      expect(published.trace.finalScore).not.toBeNull();
    }
    const independent = makeSet(true);
    expect(independent.assets[0]!.gaps.some((gap) => gap.gapId === censusId)).toBe(false);
    const withIndependent = evaluateV9FactSet(independent, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(withIndependent.exit.routes.some((route) => !route.routeSuspension && route.included)).toBe(true);
    expect(withIndependent.scoreInput.pillars.exit.limitingCauseGapIds ?? []).not.toContain(censusId);
    expect(withIndependent.scoreInput.pillars.exit.evidenceLevel).not.toBe("limited");
    if (!adverseMint) expect(withIndependent.trace.finalGrade).not.toBe("NR");
    expect(withIndependent.exit.routes.find((route) => route.routeSuspension)).toMatchObject({
      cause: "D", included: false, score: null, capacityPoint: null,
    });
  });

  it("retains measured capacity at maximum stress without promoting stale supply sizing", () => {
    const fixed = makeV9FixedInput({ assetId: ID, clockSec: CLOCK,
      supplyObservedAtSec: CLOCK - 8 * 86400 });
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: suspension }, () => {
      const compiled = compileSet(fixed);
      const asset = compiled.assets[0]!;
      expect(asset.supply.status.observationState).toBe("stale");
      expect(asset.gaps.some((gap) => gap.gapId === `${ID}:gap:exit-independent-route-census`)).toBe(false);
      const published = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(published.exit.stressRequest?.requestedNotionalUsd).toBe(25_000_000);
      expect(published.exit.stressRequest?.sizingUncertaintyReason).toBe("stale-supply");
      expect(published.exit.routes).toContainEqual(expect.objectContaining({
        included: true, capacityPoint: expect.objectContaining({ requestedNotionalUsd: 25_000_000 }),
      }));
      expect(published.exit.reasons).toContain("missing-same-notional-route");
    });
  });

  it("retains an exhaustive immaterial DEX measurement at zero beside a suspended channel", () => {
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
      expect(published.trace.adverseAttribution).toContainEqual(expect.objectContaining({
        source: "pillar-score", responsibility: "measured-adverse",
      }));
      expect(published.exit.reasons).toContain("no-viable-exit-path");
      const measured = published.exit.routes.find((route) => !route.routeSuspension)!;
      expect(measured).toMatchObject({ included: true, capacityPoint: { executableUsd: 999.9 } });
      expect(measured.score).toBe(0);
      expect(measured.capsApplied).toContain("immaterial-executable-capacity");
    });
  });

  it("does not admit future reviews or apply the notice to another route", () => {
    const config = { ...getRedemptionBackstopConfig(ID)!, routeStatus: "suspended" as const, routeSuspension: suspension };
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, Date.UTC(2026, 5, 30) / 1_000)).toBeUndefined();
    const reviewClock = Date.UTC(2026, 6, 2) / 1_000;
    expect(resolveReviewedRouteSuspension(config, suspension.routeId, reviewClock - 86_400)).toBeUndefined();
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

  it("does not author an adverse suspension or erase normal route-factor gaps before review admission", () => {
    const fixed = makeV9FixedInput({ assetId: ID, clockSec: CLOCK });
    const futureSuspension = { ...suspension, reviewedAt: "2026-10-03" };
    withRedemptionBackstopConfig(ID, { routeStatus: "suspended", routeSuspension: futureSuspension }, () => {
      const asset = compile(fixed);
      expect(asset.exitRoutes.every((route) => route.routeSuspension === undefined)).toBe(true);
      expect(asset.gaps.every((gap) => gap.causeScope?.factorKey !== "suspended")).toBe(true);
      expect(asset.evidence.every((item) => item.sourceId !== "reviewed-redemption-channel-suspension")).toBe(true);
      expect(asset.exitRoutes.every((route) => route.factorStatuses !== undefined)).toBe(true);
    });
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
