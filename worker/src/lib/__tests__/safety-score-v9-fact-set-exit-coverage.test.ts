/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it, vi } from "vitest";
import { fixedFee, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import * as redemptionBackstops from "@shared/lib/redemption-backstops";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import { buildV9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import { classifyV9DocumentationGap } from "@shared/lib/safety-score-v9/documentation";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
  selectV9ExitCirculatingUsd,
} from "@shared/lib/safety-score-v9/exit";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import {
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import * as methodologyPolicy from "@shared/lib/safety-score-v9/policy";
import * as exitExecution from "@shared/lib/safety-score-v9/exit-execution";
import reviewedExecutionModels from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { compileRouteFactorStatuses, createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { makeExecutionCertificate } from "@shared/lib/__tests__/safety-score-v9-exit-execution.test-support";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9/extension-routes";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9BoundedUnknownFeeRedemptionFixedInput as boundedUnknownFeeRedemptionFixedInput,
  makeV9FixedInput as exactFixedInput,
  makeV9Extension as extension,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9RouteReview as routeReview,
  v9ExitRouteObservation,
  v9Status,
} from "../../test-helpers/v9-fixed-input";
import { buildRoutes } from "../safety-score-v9/fact-set-exit";
import { buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";

describe("route compiler policy reuse", () => {
  it("resolves one policy per fixed input without leaking another capture's clock", () => {
    const first = factBuilderContext();
    const second = factBuilderContext(exactFixedInput({ clockSec: first.fixedInput.clockSec + 3_600 }));
    const loadPolicy = vi.spyOn(methodologyPolicy, "loadV9CandidateMethodologyPolicy");
    const validateReviews = vi.spyOn(exitExecution, "validateExitExecutionModelReviews");
    try {
      buildRoutes(first, buildSupply(first));
      buildRoutes({ ...first, evidence: new Map(), gaps: new Map() }, buildSupply(first));
      expect(loadPolicy).toHaveBeenCalledTimes(1);
      expect(loadPolicy).toHaveBeenLastCalledWith(first.fixedInput.clockSec);
      buildRoutes(second, buildSupply(second));
      expect(loadPolicy).toHaveBeenCalledTimes(2);
      expect(loadPolicy).toHaveBeenLastCalledWith(second.fixedInput.clockSec);
      expect(validateReviews).toHaveBeenCalledTimes(1);
    } finally {
      loadPolicy.mockRestore();
      validateReviews.mockRestore();
    }
  });
});

describe("route evidence independent of sizing and status labels", () => {
  it("uses maximum stress with stale supply while preserving original evidence clocks", () => {
    const draft = structuredClone(queuedRedemptionFixedInput());
    const supplyObservedAt = draft.aggregateCirculatingById.alpha!.observedAtSec!;
    draft.clockSec += 100_000;
    draft.inputFreshness.dexLiquidity.ageSeconds =
      draft.clockSec - draft.inputFreshness.dexLiquidity.updatedAt!;
    draft.inputFreshness.dexLiquidity.stale = true;
    draft.liquidityStale = true;
    const row = draft.redemptionBackstopMap.alpha!;
    row.updatedAt = draft.clockSec;
    row.sourceTimestamp = draft.clockSec;
    draft.inputFreshness.redemptionBackstops = {
      updatedAt: draft.clockSec, ageSeconds: 0, stale: false,
    };
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    observation.observedAt = draft.clockSec;
    observation.freshnessSeconds = 0;
    observation.capacityCurve!.push({
      requestedNotionalUsd: 25_000_000, maxCostBps: 200,
      executableUsd: 1_000_000, completionRatio: 0.04,
    });
    const routeObservedAt = observation.observedAt;
    const fixed = rebuildFixed(draft);
    const reviewed = extension({ clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    reviewed.sources.chainSupply.observedAtSec = supplyObservedAt;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const context = factBuilderContext(fixed, reviewed);
    const supply = buildSupply(context);
    const built = buildRoutes(context, supply);
    const result = evaluateV9Exit({
      circulatingUsd: selectV9ExitCirculatingUsd(supply),
      routes: built.exitRoutes.map(projectV9ExitEvaluationRoute), gaps: [...context.gaps.values()],
    }, V9_CANDIDATE_POLICY_V1);
    expect(selectV9ExitCirculatingUsd(supply)).toBeNull();
    expect(result.stressRequest?.requestedNotionalUsd).toBe(25_000_000);
    const route = built.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
    expect(result.routes.find((candidate) => candidate.routeKey === route.routeKey)?.included).toBe(true);
    expect(context.evidence.get(route.status.evidenceRefIds[0]!)?.observedAtSec).toBe(routeObservedAt);
    expect(fixed.aggregateCirculatingById.alpha!.observedAtSec).toBe(supplyObservedAt);
  });

  it.each([
    { routeStatus: "open", evidenceKind: "onchain-contract-state", admitted: true },
    { routeStatus: "unknown", evidenceKind: "onchain-contract-state", admitted: true },
    { routeStatus: "paused", evidenceKind: "onchain-contract-state", admitted: false },
    { routeStatus: "suspended", evidenceKind: "onchain-contract-state", admitted: false },
    { routeStatus: "open", evidenceKind: "documented-terms", admitted: false },
  ] as const)("uses execution, not status labels: $routeStatus / $evidenceKind", ({ routeStatus, evidenceKind, admitted }) => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, true));
    const row = draft.redemptionBackstopMap.alpha!;
    Object.assign(row, { routeStatus, routeStatusSource: "static-config", sourceMode: "dynamic",
      capacityKind: "live-direct", settlementModel: "atomic", settlementDelaySec: 0,
      accessModel: "permissionless-onchain", holderEligibility: "any-holder", feeBps: 0 });
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    observation.evidenceKind = evidenceKind;
    if (routeStatus === "unknown") observation.scoreEligible = false;
    const fixed = rebuildFixed(draft);
    const reviewed = extension({ clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const context = factBuilderContext(fixed, reviewed);
    const route = buildRoutes(context, buildSupply(context)).exitRoutes.find((candidate) => candidate.lane === "redemption")!;
    expect(route.status.observationState).toBe(routeStatus === "paused" || routeStatus === "suspended" ? "unsupported" : "known");
    if (routeStatus === "open" || routeStatus === "unknown") expect(route.coverageClass).toBe(admitted ? "exact-lower-bound" : "diagnostic");
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, gaps: [...context.gaps.values()],
      routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey === route.routeKey).toBe(admitted);
  });
});

describe("configured redemption channel census", () => {
  const clockSec = Date.parse("2026-10-20T12:00:00Z") / 1_000;
  const config: RedemptionBackstopConfig = {
    routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "days",
    executionModel: "rules-based-nav", outputAssetType: "stable-single",
    capacityModel: { kind: "unquantified" },
    costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" },
    reviewedAt: "2026-10-03",
    docs: [{ label: "Issuer redemption terms", url: "https://example.com/redemption", supports: ["route"] }],
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: ["capacity", "cost", "settlement"],
      rationale: "A real primary channel exists but funded capacity, all-in cost and completed payout are unquantified.",
      reviewedAt: "2026-10-03",
      docs: [{ label: "Issuer redemption terms", url: "https://example.com/redemption", supports: ["route"] }],
    },
  };

  function emptyDexContext(withMeasuredZeroDex = false, rowState?: "missing-capacity" | "impaired") {
    const draft = exactFixedInput({ clockSec });
    if (withMeasuredZeroDex) {
      const observation = draft.dexLiqMap.alpha!.exitRouteObservations![0]!;
      observation.executableUsd = 0;
      observation.completionRatio = 0;
      observation.capacityCurve = observation.capacityCurve!.map((point) => ({
        ...point, executableUsd: 0, completionRatio: 0,
      }));
    } else {
      draft.dexLiqMap.alpha!.exitRouteObservations = [];
      draft.dexLiqMap.alpha!.exitRouteObservationCoverage = {
        status: "populated", capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
        retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0, unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {},
      };
    }
    draft.dexDeploymentSupplyCoverageById.alpha = {
      totalSupplyUsd: 10_000_000, verifiedNoPoolsSupplyUsd: 10_000_000, verifiedNoPoolsSupplyRatio: 1,
      observedSupplyUsd: 0, observedSupplyRatio: 0, providerInaccessibleSupplyUsd: 0,
      providerInaccessibleSupplyRatio: 0, unknownSupplyUsd: 0, unknownSupplyRatio: 0, unknownChains: [],
    };
    if (rowState) {
      draft.redemptionBackstopMap.alpha = makeSupplyFullRedemption({
        stablecoinId: "alpha", resolutionState: rowState, capacityProfile: undefined, updatedAt: clockSec,
      });
      draft.redemptionGenerationId = "redemption:configured-channel-census";
      draft.redemptionStale = false;
      draft.inputFreshness.redemptionBackstops = { updatedAt: clockSec, ageSeconds: 0, stale: false };
    }
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension({ clockSec, registryFingerprint: fixed.registryFingerprint }));
    if (withMeasuredZeroDex) reviewed.assets[0]!.routeReviews[0]!.coverageClass = "exact-complete";
    else reviewed.assets[0]!.routeReviews = [];
    return factBuilderContext(fixed, reviewed);
  }

  it.each(["unquantified-row", "absent-row", "impaired-row", "measured-zero-dex"] as const)(
    "retains unavailable primary-channel evidence without capacity credit: %s", (scenario) => {
      const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(config);
      try {
        const context = emptyDexContext(scenario === "measured-zero-dex",
          scenario === "unquantified-row" ? "missing-capacity" : scenario === "impaired-row" ? "impaired" : undefined);
        const compiled = buildRoutes(context, buildSupply(context));
        const channel = compiled.exitRoutes.find((route) => route.lane === "redemption")!;
        expect(channel).toMatchObject({
          routeId: "redemption:alpha:offchain-issuer", routeFamily: "issuer-redemption",
          scoreEligible: false, coverageClass: "diagnostic", request: null, capacityCurve: [],
          settlementSlaSec: null, status: { observationState: "missing" },
          output: { kind: "unknown", valuation: null },
        });
        expect(context.evidence.get("alpha:redemption-configured-channel")).toMatchObject({
          observedAtSec: Date.parse("2026-10-03") / 1_000,
          sourceGenerationId: context.extension.sources.researchOverlays.generationId,
        });
        expect(compiled.exitStatus.observationState).toBe("bounded-unknown");
        const evaluated = evaluateV9Exit({
          circulatingUsd: 10_000_000, portfolioFactStatus: compiled.exitStatus,
          gaps: [...context.gaps.values()], routes: compiled.exitRoutes.map(projectV9ExitEvaluationRoute),
        }, V9_CANDIDATE_POLICY_V1);
        expect(evaluated.score).toBe(scenario === "measured-zero-dex" ? 0 : 50);
        if (scenario === "measured-zero-dex") {
          expect(evaluated.reasons).toContain("no-viable-exit-path");
        } else {
          expect(evaluated.reasons).toContain("missing-same-notional-route");
          expect(evaluated.reasons).not.toContain("no-viable-exit-path");
        }
        expect(evaluated.routes.find((route) => route.routeKey === channel.routeKey)).toMatchObject({
          included: false, capacityPoint: null,
        });
        if (scenario === "measured-zero-dex") {
          expect(evaluated.routes.find((route) => route.lane === "dex")).toMatchObject({ included: true, score: 0 });
        }
      } finally {
        getConfig.mockRestore();
      }
    },
  );

  it.each([
    { name: "absent config", value: null },
    { name: "uncited config", value: { ...config, docs: [] } },
    { name: "same-day review", value: { ...config, reviewedAt: "2026-10-20" } },
    { name: "future review", value: { ...config, reviewedAt: "2026-10-21" } },
  ])("does not create a channel from $name", ({ value }) => {
    const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(value);
    try {
      const context = emptyDexContext();
      const compiled = buildRoutes(context, buildSupply(context));
      expect(compiled.exitRoutes).toEqual([]);
      expect(compiled.exitStatus.observationState).toBe("known");
      expect(context.evidence.has("alpha:redemption-configured-channel")).toBe(false);
    } finally {
      getConfig.mockRestore();
    }
  });
});

describe("reviewed execution-model gap expiry", () => {
  it.each([
    { offset: -1, expectedGap: true },
    { offset: 0, expectedGap: true },
    { offset: 1, expectedGap: false },
  ])("enumerates missing certificates through the inclusive expiry (offset $offset)", ({ offset, expectedGap }) => {
    const review = exitExecution.validateExitExecutionModelReviews(reviewedExecutionModels, V9_CANDIDATE_POLICY_V1)
      .find((entry) => V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels[entry.modelId]!.admission === "enabled")!;
    const assetId = review.identity.assetId;
    const clockSec = Date.parse(review.expiresAt) / 1000 + offset;
    const fixed = exactFixedInput({ assetId, clockSec });
    const context = factBuilderContext(fixed, extension({ assetId, clockSec, registryFingerprint: fixed.registryFingerprint }));
    const routes = buildRoutes(context, buildSupply(context));
    const gapId = `${assetId}:gap:exit-execution:${exitExecution.exitExecutionReviewDigest(review)}`;
    expect(routes.exitStatus.gapIds.includes(gapId)).toBe(expectedGap);
    expect(context.gaps.has(gapId)).toBe(expectedGap);
    if (expectedGap) {
      expect(context.gaps.get(gapId)).toMatchObject({
        reasonCode: "missing-runtime-route-evidence", observationState: "missing", responsibility: "unresearched",
        causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      });
    }
  });
});

describe("explicit route factor gaps and source chronology", () => {
  it.each([
    { clock: "2026-07-13T12:00:00Z", admitted: false },
    { clock: "2026-07-13T23:59:59Z", admitted: false },
    { clock: "2026-07-14T00:00:00Z", admitted: true },
  ])("admits the same date-only review in coverage and factor gates at $clock", ({ clock, admitted }) => {
    const assetId = "usdc-circle";
    const draft = exactFixedInput({ assetId, clockSec: Date.parse(clock) / 1000 });
    draft.redemptionBackstopMap = { [assetId]: makeSupplyFullRedemption({ feeBps: 7, updatedAt: draft.clockSec }) };
    draft.redemptionStale = false;
    draft.redemptionGenerationId = "redemption:review-admission";
    draft.inputFreshness.redemptionBackstops = { updatedAt: draft.clockSec, ageSeconds: 0, stale: false };
    const fixed = rebuildFixed(draft);
    withRedemptionBackstopConfig(assetId, { v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: ["cost"], reviewedAt: "2026-07-13",
      rationale: "The exact route cost bound has not been established.",
      docs: [{ label: "Route terms", url: "https://example.com/route", supports: ["route"] }],
    } }, () => {
      const reviewed = structuredClone(extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint }));
      reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
      reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
      const route = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!.exitRoutes
        .find((candidate) => candidate.lane === "redemption")!;
      expect(route.coverageClass).toBe("exact-lower-bound");
      expect(route.factorStatuses.cost!.observationState).toBe(admitted ? "missing" : "known");
    });
  });

  it.each([
    { factor: "cost", nonCanonical: false }, { factor: "cost", nonCanonical: true },
    { factor: "settlement", nonCanonical: false }, { factor: "settlement", nonCanonical: true },
    { factor: "capacity", nonCanonical: false }, { factor: "capacity", nonCanonical: true },
  ] as const)("preserves the $factor gap and captured diagnostics (noncanonical: $nonCanonical)", ({ factor, nonCanonical }) => {
    const assetId = "usdc-circle";
    const row = makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: 7 });
    if (nonCanonical) {
      const observation = buildSafetyScoreV9RetainedRedemptionRoutes(
        { ...exactFixedInput({ assetId, clockSec: Date.UTC(2026, 6, 13) / 1000 }),
          redemptionBackstopMap: { [assetId]: row } }, assetId,
      )[0]!.observation;
      row.capacityProfile = { ...row.capacityProfile!, exitRouteObservations: [{
        ...observation, routeId: `redemption:${assetId}:fpi-controller:ethereum`,
      }] };
    }
    const draft = exactFixedInput({ assetId, clockSec: Date.UTC(2026, 6, 13) / 1000 });
    draft.redemptionBackstopMap = { [assetId]: row };
    draft.redemptionStale = false;
    draft.redemptionGenerationId = "redemption:explicit-missing-factors";
    draft.inputFreshness.redemptionBackstops = { updatedAt: draft.clockSec, ageSeconds: 0, stale: false };
    const fixed = rebuildFixed(draft);
    const capturedCapacity = structuredClone(fixed.redemptionBackstopMap[assetId]!.capacityProfile);
    withRedemptionBackstopConfig(assetId, { v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: [factor], reviewedAt: "2026-07-01",
      rationale: "The exact completion, cost or capacity bound has not been established.",
      docs: [{ label: "Route terms", url: "https://example.com/route", supports: ["route"] }],
    } }, () => {
      const reviewed = structuredClone(extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint }));
      reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
      reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
      const asset = compiled.assets[0]!;
      const route = asset.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
      if (factor === "capacity") {
        expect(route).toMatchObject({
          coverageClass: "diagnostic", status: { observationState: "missing" },
          request: null, capacityCurve: [], scoreEligible: false,
        });
      } else {
        expect(route.coverageClass).toBe("exact-lower-bound");
        expect(route.capacityCurve.some((point) => point.executionCostBps === 7)).toBe(true);
      }
      expect(fixed.redemptionBackstopMap[assetId]!.capacityProfile).toEqual(capturedCapacity);
      expect(route.settlementSlaSec).toBe(0);
      expect(route.factorStatuses[factor]!.observationState).toBe("missing");
      const gap = asset.gaps.find((candidate) => route.factorStatuses[factor]!.gapIds.includes(candidate.gapId))!;
      expect(gap.causeScope).toMatchObject({ routeKey: route.routeKey, factorKey: factor, requiredDatum: factor });
      if (factor === "cost" || factor === "settlement") {
        expect(gap.policyRuleId).toBe("v9.exit.reviewed-terms");
        expect(["C", "U"]).toContain(gap.causeProof.cause);
      }
      const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(evaluated.exit.causeGapIds).toContain(gap.gapId);
    });
  });

  it.each([{ feeBpsMin: 25 }, { minFeeUsd: 1_000 }])("keeps minimum-only fees in the cost cause gaps (%j)", (minimum) => {
    const assetId = "usdc-circle";
    const draft = exactFixedInput({ assetId, clockSec: Date.UTC(2026, 6, 13) / 1000 });
    draft.redemptionBackstopMap = { [assetId]: makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: null }) };
    draft.redemptionStale = false;
    draft.redemptionGenerationId = "redemption:minimum-only-cost";
    draft.inputFreshness.redemptionBackstops = { updatedAt: draft.clockSec, ageSeconds: 0, stale: false };
    const fixed = rebuildFixed(draft);
    withRedemptionBackstopConfig(assetId, {
      costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula", ...minimum },
      v9RouteReviewTerms: undefined, v9RouteCostTerms: undefined,
    }, () => {
      const reviewed = structuredClone(extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint }));
      reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
      reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
      const route = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
      expect(route.factorStatuses.cost!.observationState).toBe("missing");
      const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(evaluated.exit.causeGapIds).toEqual(expect.arrayContaining(route.factorStatuses.cost!.gapIds));
    });
  });

  it.each(["older", "newer", "diagnostic", "noncanonical-older", "noncanonical-newer", "rejected", "stricter"] as const)(
    "resolves primary terms gaps only for newly admitted exact evidence (%s)", (scenario) => {
      const fixed = exactFixedInput({ assetId: "usdc-circle", clockSec: Date.UTC(2026, 6, 13) / 1000 });
      const reviewed = extension({ assetId: "usdc-circle", clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
      const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixed), reviewed, reviewed.assets[0]!, "a".repeat(64));
      const base = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), extension()).assets[0]!.exitRoutes[0]!;
      const certificate = makeExecutionCertificate();
      certificate.identity = { ...certificate.identity, assetId: "usdc-circle" };
      const reviewSec = Date.parse("2026-07-01T00:00:00Z") / 1000;
      certificate.observedAtSec = certificate.source.timestamp = reviewSec +
        (scenario === "older" || scenario === "noncanonical-older" ? -1 : 86400);
      const point = certificate.points[0]!;
      if (scenario === "diagnostic") { point.certification = "diagnostic"; point.reason = "execution-unavailable"; }
      const evidence = createV9EvidenceReference({ evidenceId: "exact:route", sourceId: "exact:source",
        sourceGenerationId: "exact:generation", observedAtSec: certificate.observedAtSec,
        disposition: scenario === "rejected" ? "rejected" : "observed",
        ...(scenario === "rejected" ? { rejection: { code: "rejected", reason: "Rejected read", rejectedAtSec: fixed.clockSec } } : {}),
      }, fixed.clockSec);
      context.evidence.set(evidence.evidenceId, evidence);
      const route = { ...base, lane: "redemption" as const,
        routeId: scenario.startsWith("noncanonical") ? "execution:exact-request-digest" : "redemption:usdc-circle:offchain-issuer",
        executionCertificate: certificate,
        executionModelId: certificate.modelId,
        request: { requestedNotionalUsd: point.requestedNotionalUsd, maxCostBps: point.maxCostBps, settlementHorizonSec: 300 },
        status: { ...base.status, observationState: "known" as const, evidenceRefIds: [evidence.evidenceId] },
        factorStatuses: scenario === "stricter" ? { cost: { ...base.status, observationState: "unsupported" as const, gapIds: ["existing:rejected"] } } : {},
      };
      withRedemptionBackstopConfig("usdc-circle", { v9RouteReviewTerms: {
        scoringDisposition: "bounded-terms-gap", missingScoringFields: ["cost", "settlement", "capacity"], reviewedAt: "2026-07-01",
        rationale: "Exact bounds remain unknown.", docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["route"] }],
      } }, () => {
        const compiled = compileRouteFactorStatuses(context, route);
        expect(compiled.factorStatuses.cost!.observationState)
          .toBe(scenario === "stricter" ? "unsupported" : scenario === "newer" || scenario === "noncanonical-newer" ? "known" : "missing");
        if (scenario === "stricter") expect(compiled.factorStatuses.cost!.gapIds).toEqual(["existing:rejected"]);
      });
    },
  );
});

describe("Safety Score v9 exact base fact-set adapter — exit and DEX coverage", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it.each([201])("re-admits a reviewed %s bps cost as zero within the request budget without quarantine", (costBps) => {
    const fixed = queuedRedemptionFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const redemptionReview = reviewed.assets[0]!.routeReviews.find((route) => route.lane === "redemption")!;
    redemptionReview.executionCosts = redemptionReview.executionCosts.map((point) => ({
      ...point, executionCostBps: costBps,
    }));
    const normalized = normalizeSafetyScoreV9CompilerInput(fixed);
    const admitted = materializeSafetyScoreV9FactSetExtension(normalized, reviewed);
    const compiled = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(normalized, admitted);
    expect(compiled.quarantines).toEqual([]);
    const route = compiled.factSet.assets[0]!.exitRoutes.find((entry) => entry.lane === "redemption")!;
    expect(route.capacityCurve).toEqual([
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: costBps },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: costBps },
    ]);
    expect(fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!.executableUsd).toBe(1_000_000);
  });

  it.each([199, 200])("preserves executable capacity for a reviewed %s bps cost within the request budget", (costBps) => {
    const fixed = queuedRedemptionFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const redemptionReview = reviewed.assets[0]!.routeReviews.find((route) => route.lane === "redemption")!;
    redemptionReview.executionCosts = redemptionReview.executionCosts.map((point) => ({
      ...point, executionCostBps: costBps,
    }));
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    expect(compiled.assets[0]!.exitRoutes.find((entry) => entry.lane === "redemption")!.capacityCurve).toEqual([
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 100_000, completionRatio: 1, executionCostBps: costBps },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: costBps },
    ]);
  });

  it("retains the production curve when no reviewed cost overrides its realized costs", () => {
    const draft = structuredClone(queuedRedemptionFixedInput());
    const observation = draft.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
    observation.capacityCurve = observation.capacityCurve!.map((point) => ({ ...point, executionCostBps: 7 }));
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    expect(compiled.assets[0]!.exitRoutes.find((entry) => entry.lane === "redemption")!.capacityCurve).toEqual(observation.capacityCurve);
  });

  it.each([false, true])("excludes proven unavailable live-only redemption without reviving an exhausted DEX (empty DEX: %s)", (emptyDex) => {
    const fixed = structuredClone(queuedRedemptionFixedInput());
    const redemption = fixed.redemptionBackstopMap.alpha!;
    redemption.provider = "reserve-sync-metadata";
    redemption.resolutionState = "missing-capacity";
    redemption.capacityBasis = "live-direct-telemetry";
    redemption.capacityProfile = undefined;
    redemption.routeStatus = "open";
    const dex = fixed.dexLiqMap.alpha!;
    if (emptyDex) {
      dex.exitRouteObservations = [];
      dex.exitRouteObservationCoverage = {
        ...dex.exitRouteObservationCoverage!,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        evidenceCounts: {},
      };
    }
    else for (const observation of dex.exitRouteObservations ?? []) {
      observation.executableUsd = 0;
      observation.completionRatio = 0;
      for (const point of observation.capacityCurve ?? []) {
        point.executableUsd = 0;
        point.completionRatio = 0;
      }
    }
    const rebuilt = rebuildFixed(fixed);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = rebuilt.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(rebuilt, "alpha");
    const normalized = normalizeSafetyScoreV9CompilerInput(rebuilt);
    const isolated = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(normalized,
      materializeSafetyScoreV9FactSetExtension(normalized, reviewed));
    expect(isolated.quarantines).toEqual([]);
    const compiled = isolated.factSet;
    const asset = compiled.assets[0]!;
    const missing = asset.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(missing.status.observationState).toBe("missing");
    expect(missing.capacityCurve).toEqual([]);
    expect(missing.scoreEligible).toBe(false);
    expect(asset.gaps.find((gap) => missing.status.gapIds.includes(gap.gapId))!.causeProof).toMatchObject({
      cause: "A", rejectionCode: "live-direct-capacity-unavailable",
    });
    const result = evaluateV9Exit({
      circulatingUsd: 10_000_000,
      portfolioStatus: "incomplete",
      gaps: asset.gaps, portfolioFactStatus: asset.exitStatus,
      routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(emptyDex ? 50 : 0);
    expect(result.aggregationDisposition).toBe("included");
    if (emptyDex) expect(result.limitedEvidenceCauses).toContain("U");
    expect(result.routes.find((route) => route.routeKey === missing.routeKey)).toMatchObject({
      score: null, included: false, capacityPoint: null,
    });

  });

  it.each(["absent", "paused", "degraded", "resolved"] as const)("does not invent a missing-capacity diagnostic for %s redemption", (state) => {
    const fixed = structuredClone(queuedRedemptionFixedInput());
    const redemption = fixed.redemptionBackstopMap.alpha!;
    redemption.provider = "reserve-sync-metadata";
    redemption.resolutionState = state === "resolved" ? "resolved" : "missing-capacity";
    redemption.capacityBasis = "live-direct-telemetry";
    redemption.routeStatus = state === "paused" || state === "degraded" ? state : "open";
    redemption.capacityProfile = undefined;
    if (state === "absent") {
      fixed.redemptionBackstopMap = exactFixedInput().redemptionBackstopMap;
      fixed.redemptionGenerationId = exactFixedInput().redemptionGenerationId;
      fixed.redemptionStale = exactFixedInput().redemptionStale;
      fixed.inputFreshness.redemptionBackstops = exactFixedInput().inputFreshness.redemptionBackstops;
    }
    const rebuilt = rebuildFixed(fixed);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = rebuilt.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(rebuilt, "alpha");
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(rebuilt, reviewed);
    expect(compiled.assets[0]!.exitRoutes.some((route) => route.lane === "redemption")).toBe(false);
  });

  it("canonicalizes fractional capacity points in ascending numeric order", () => {
    const fixed = structuredClone(exactFixedInput());
    const observation = fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.capacityCurve = [
      {
        requestedNotionalUsd: 2.5,
        maxCostBps: 10.25,
        executableUsd: 2.5,
        completionRatio: 1,
        executionCostBps: 10,
      },
      {
        requestedNotionalUsd: 10.5,
        maxCostBps: 9.5,
        executableUsd: 10.5,
        completionRatio: 1,
        executionCostBps: 9,
      },
    ];
    const dex = buildSafetyScoreV9RouteReviews(fixed, "alpha").find(
      (review) => review.lane === "dex" && review.routeId === observation.routeId,
    )!;
    expect(dex.executionCosts.map((point) => [
      point.maxCostBps,
      point.requestedNotionalUsd,
    ])).toEqual([
      [9.5, 10.5],
      [10.25, 2.5],
    ]);
  });

  it("preserves live queued terms through the production review and fact boundary", () => {
    const fixed = queuedRedemptionFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      capacityScoringHorizon: "queued",
      settlementModel: "queued",
      settlementSlaSec: 30 * 86_400,
      queueDepthUsd: 1_500_000,
      dailyLimitUsd: 1_000_000,
      minRedeemUsd: 1_000_000,
      request: { settlementHorizonSec: 30 * 86_400 },
    });

    const exit = evaluateV9Exit(
      {
        circulatingUsd: 10_000_000,
        portfolioStatus: "reviewed-complete",
        routes: [projectV9ExitEvaluationRoute(redemption)],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.primaryRouteKey).toBe(redemption.routeKey);
    expect(exit.routes[0]).toMatchObject({
      capacityScoringHorizon: "queued",
      settlementDelaySec: 30 * 86_400,
      capsApplied: expect.arrayContaining(["queue-backlog:0.65", "minimum-redeem:0.75"]),
    });
  });

  it("carries an unproven settlement bound from the queued observation into the route fact", () => {
    // eEARN's real shape: the flagged operator queue is the only exit route
    // (zero DEX pools), so the bounded gap is the pillar's score-bearing
    // evidence rather than an auxiliary diagnostic beside a scored route.
    const fixed = queuedRedemptionFixedInput();
    fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!.settlementBoundUnproven = true;
    fixed.dexLiqMap.alpha = {
      ...fixed.dexLiqMap.alpha!,
      exitRouteObservations: [],
      exitRouteObservationCoverage: {
        ...fixed.dexLiqMap.alpha!.exitRouteObservationCoverage!,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        evidenceCounts: {},
      },
    };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      settlementBoundUnproven: true,
      scoreEligible: false,
      settlementModel: "queued",
    });

    // A usable curve remains score-bearing; only its unproven settlement
    // subfactor is unknown, and bounded recovery cannot exceed 70.
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.score).toBeGreaterThan(0);
    expect(evaluated.exit.score).toBeLessThanOrEqual(70);
    expect(evaluated.exit.routes.find((route) => route.routeKey === redemption.routeKey)).toMatchObject({
      included: true, components: { settlement: 50 },
    });
    expect(evaluated.exit.reasons).not.toContain("no-viable-exit-path");
    const settlementGapIds = redemption.factorStatuses!.settlement!.gapIds;
    expect(settlementGapIds).toHaveLength(1);
    const trace = evaluated.exit.routes.find((route) => route.routeKey === redemption.routeKey)!;
    expect(trace.factorContributions?.settlement).toMatchObject({
      score: 50, causeGapIds: settlementGapIds, cause: "U",
      scoringDisposition: "bounded-uncertainty",
    });
  });

  it("withdraws producer eligibility when the v9 review has an unbounded settlement queue", () => {
    const fixed = queuedRedemptionFixedInput(300, true);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha").map((review) => ({
      ...review,
      settlementModel: "queued",
      settlementSlaSec: null,
      settlementHorizonSec: 30 * 86_400,
    }));

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      settlementModel: "queued",
      settlementSlaSec: null,
      scoreEligible: false,
      request: { settlementHorizonSec: 30 * 86_400 },
    });
  });

  it("never shortens a captured route below the conservative reviewed settlement horizon", () => {
    const fixed = queuedRedemptionFixedInput(86_400);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");

    const redemption = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!.exitRoutes.find(
      (route) => route.lane === "redemption",
    )!;
    expect(redemption.request?.settlementHorizonSec).toBe(30 * 86_400);
  });

  it("preserves reviewed capacity without inventing a quantified fee or admitting execution credit", () => {
    const fixed = boundedUnknownFeeRedemptionFixedInput({ clockSec: 86_400 });
    const reviewed = structuredClone(extension({ clockSec: fixed.clockSec }));
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.assetId = "usdc-circle";
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "usdc-circle");
    reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "usdc-circle");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      feeEvidence: "undisclosed-reviewed",
      scoreEligible: false,
      status: { observationState: "known" },
    });
    expect(redemption.capacityCurve.every((point) => point.executableUsd > 0)).toBe(true);

    const exit = evaluateV9Exit(
      {
        circulatingUsd: 10_000_000,
        portfolioStatus: "reviewed-complete",
        gaps: compiled.assets[0]!.gaps,
        portfolioFactStatus: compiled.assets[0]!.exitStatus,
        routes: [projectV9ExitEvaluationRoute(redemption)],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.routes[0]).toMatchObject({
      included: true,
      rawSameNotionalCostBps: null, components: { cost: 50 },
    });
  });

  it("carries measured route history into v9 facts and evaluation traces", () => {
    const fixed = structuredClone(exactFixedInput());
    const observation = fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = "measured-executable-depth";
    observation.observationHistory = {
      completeProducerCycleCount: 3,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 0,
      observationWindowStartedAt: observation.observedAt - 200,
      observationWindowEndedAt: observation.observedAt,
      latestOperationalFailureAt: observation.observedAt,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: observation.capacityCurve!,
    };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const reviewed = structuredClone(extension());
    reviewed.assets[0]!.routeReviews[0]!.modelConfidence = "high";

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({
      routeFamily: "dex-amm",
      modelConfidence: "high",
      observationHistory: {
        completeProducerCycleCount: 3,
        successfulObservationCount: 2,
        latestOperationalFailureAt: observation.observedAt,
        conservativeStatistic: "pointwise-minimum",
      },
    });

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.routes[0]).toMatchObject({
      routeFamily: "dex-amm",
      observationConfidence: "high",
      modelConfidence: "high",
      observationHistory: {
        successfulObservationCount: 2,
        latestOperationalFailureAt: observation.observedAt,
      },
    });
    expect(evaluated.scoreInput.pillars.exit.evidenceLevel).toBe("strong");

    const immatureFixed = structuredClone(exactFixedInput());
    immatureFixed.dexLiqMap.alpha!.exitRouteObservations![0]!.evidenceKind = "measured-executable-depth";
    immatureFixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(immatureFixed);
    const immature = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(immatureFixed, extension()),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(immature.scoreInput.pillars.exit.evidenceLevel).not.toBe("strong");
  });

  it.each(["exact-lower-bound", "exact-complete"] as const)(
    "retains R1 materiality semantics for small %s execution evidence",
    (coverageClass) => {
      const draft = structuredClone(exactFixedInput());
      const observation = draft.dexLiqMap.alpha!.exitRouteObservations![0]!;
      observation.executableUsd = 13;
      observation.completionRatio = 13 / observation.requestedNotionalUsd;
      observation.capacityCurve = observation.capacityCurve!.map((point) => ({
        ...point,
        executableUsd: 13,
        completionRatio: 13 / point.requestedNotionalUsd,
      }));
      const fixed = rebuildFixed(draft);
      const reviewed = structuredClone(extension());
      reviewed.registryFingerprint = fixed.registryFingerprint;
      reviewed.assets[0]!.routeReviews[0]!.coverageClass = coverageClass;
      const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
      const route = asset.exitRoutes[0]!;
      expect(asset.exitStatus).toMatchObject({ observationState: "known", gapIds: [] });
      expect(route).toMatchObject({
        scoreEligible: true,
        coverageClass,
        status: { observationState: "known", gapIds: [] },
      });
      const result = evaluateV9Exit({
        circulatingUsd: asset.supply.circulatingUsd,
        gaps: asset.gaps,
        portfolioFactStatus: asset.exitStatus,
        routes: [projectV9ExitEvaluationRoute(route)],
      }, V9_CANDIDATE_POLICY_V1);
      if (coverageClass === "exact-complete") {
        expect(result.routes[0]).toMatchObject({
          included: true, score: 0, capacityPoint: { executableUsd: 13 },
          capsApplied: ["immaterial-executable-capacity"],
        });
        expect(result.score).toBe(0);
        expect(result.reasons).toContain("no-viable-exit-path");
      } else {
        expect(result.routes[0]).toMatchObject({
          included: false, score: null, capacityPoint: null,
          exclusionReason: "missing-same-notional-route",
        });
        expect(result.primaryRouteKey).toBeNull();
        expect(result.score).toBe(50);
        expect(result.reasons).not.toContain("no-viable-exit-path");
      }
    },
  );

  it("joins route display names and supply IDs into one canonical chain common mode", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      routeChain: "Monad",
      chainSupplyByChain: { monad: { ...template, current: 10_000_000 } },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(alpha.exitRoutes[0]!.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    expect(alpha.supply.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    const group = buildV9DependencyEvaluationPlan(compiled).commonModeGroups.find(
      (candidate) => candidate.failureDomain.kind === "chain" && candidate.failureDomain.key === "monad",
    );
    expect(group?.members).toEqual([
      { assetId: "alpha", owner: "exit", pathKey: alpha.exitRoutes[0]!.routeKey },
      { assetId: "alpha", owner: "supply", pathKey: "supply" },
    ]);
  });

  it("attributes chain-contract redemption routes to a redemption rail, not a DEX protocol", () => {
    const fixed = queuedRedemptionFixedInput();
    const observation = fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
    observation.routeFamily = "protocol-redemption";
    observation.scope = {
      kind: "chain-contract",
      chain: "ethereum",
      contractOrPoolId: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
      protocol: "frax",
    };
    const reviewed = extension();
    reviewed.assets[0]!.routeReviews.push({
      ...routeReview(observation.routeId),
      lane: "redemption",
      failureDomains: [],
    });

    const rebuilt = rebuildFixed(fixed);
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(rebuilt, reviewed);
    const redemptionRoute = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.lane === "redemption")!;

    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "chain", key: "ethereum" });
    expect(redemptionRoute.failureDomains).toContainEqual({
      kind: "redemption-rail", key: "provider:ethereum:0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
    });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "redemption-rail", key: "frax" });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "dex-protocol", key: "frax" });
  });

  it.each([
    ["different contracts", "ethereum", "0x2222222222222222222222222222222222222222", false],
    ["different chains", "base", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false],
    ["the same canonical endpoint", "Ethereum", "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", true],
  ] as const)("does not conflate a redemption model across %s", (_label, chain, contractOrPoolId, shared) => {
    const compileEndpoint = (endpointChain: string, endpoint: string) => {
      const fixed = queuedRedemptionFixedInput();
      const observation = fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
      observation.routeFamily = "protocol-redemption";
      observation.scope = {
        kind: "chain-contract", chain: endpointChain, contractOrPoolId: endpoint, protocol: "erc4626-instant",
      };
      const reviewed = extension();
      reviewed.assets[0]!.routeReviews.push({
        ...routeReview(observation.routeId), lane: "redemption",
        failureDomains: [{ kind: "oracle-feed", key: "reviewed-shared-oracle" }],
      });
      return compileSafetyScoreV9FactSetFromFixedInput(rebuildFixed(fixed), reviewed).assets[0]!;
    };
    const alpha = compileEndpoint("ethereum", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const beta = { ...compileEndpoint(chain, contractOrPoolId), assetId: "beta" };
    const plan = buildV9DependencyEvaluationPlan({ activeAssetIds: ["alpha", "beta"], assets: [alpha, beta] });
    const rails = plan.commonModeGroups.filter((group) => group.failureDomain.kind === "redemption-rail");
    expect(rails.some((group) => group.failureDomain.key === "erc4626-instant")).toBe(false);
    expect(rails.some((group) =>
      group.failureDomain.key === "provider:ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" &&
      new Set(group.members.map((member) => member.assetId)).size === 2,
    )).toBe(shared);
    // Exact reviewed dependencies survive even when the redemption endpoints differ.
    expect(plan.commonModeGroups).toContainEqual(expect.objectContaining({
      failureDomain: { kind: "oracle-feed", key: "reviewed-shared-oracle" },
      members: expect.arrayContaining([
        expect.objectContaining({ assetId: "alpha", owner: "exit" }),
        expect.objectContaining({ assetId: "beta", owner: "exit" }),
      ]),
    }));
    expect(alpha.exitRoutes.filter((route) => route.lane === "dex").flatMap((route) => route.failureDomains))
      .toContainEqual({ kind: "dex-protocol", key: "fixture-dex" });
  });

  it("keeps shaped diagnostic pools out of the DEX completeness denominator without hiding exact gates", () => {
    const fixedWithCoverage = (
      exactCapabilityPoolCount: number,
      extraGate?: Record<string, number>,
    ) => {
      const original = exactFixedInput();
      return rebuildFixed({
        ...original,
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservationCoverage: {
              status: "populated",
              capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
              retainedPoolCount: 2_380 + exactCapabilityPoolCount,
              observationCount: 1,
              scoreEligibleObservationCount: 1,
              scoreEligiblePoolCount: 1,
              scoreEligibleCapabilityPoolCount: exactCapabilityPoolCount,
              unsupportedPoolCount: 2_379 + exactCapabilityPoolCount,
              evidenceCounts: { "reserve-based-amm-simulation": 1 },
              unsupportedReasons: {
                "nonExecutableEvidence:defillama-pool-shaped": 1_449,
                "nonExecutableEvidence:curve-stableswap-shaped": 11,
                "nonExecutableEvidence:direct-api-amm-shaped": 653,
                "nonExecutableEvidence:discovery-pool-shaped": 267,
                ...(exactCapabilityPoolCount > 1
                  ? (extraGate ?? { "executionCapabilityGate:measured-execution:quote-failed": 1 })
                  : {}),
              },
            },
          },
        },
      });
    };

    const complete = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(1), extension()).assets[0]!;
    expect(complete.exitStatus.observationState).toBe("known");
    expect(complete.gaps.map((gap) => gap.reasonCode)).not.toContain("incomplete-dex-route-coverage");

    const gated = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(2), extension()).assets[0]!;
    expect(gated.exitStatus.observationState).toBe("bounded-unknown");
    expect(gated.gaps.map((gap) => gap.reasonCode)).toContain("incomplete-dex-route-coverage");

    const modelLimitOnly = compileSafetyScoreV9FactSetFromFixedInput(
      fixedWithCoverage(2, { "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1 }),
      extension(),
    ).assets[0]!;
    expect(modelLimitOnly.exitStatus.observationState).toBe("known");
    expect(modelLimitOnly.gaps.map((gap) => gap.reasonCode)).not.toContain("incomplete-dex-route-coverage");
  });

  it("does not infer an immaterial missing DEX remainder from pool counts or supply materiality", () => {
    const run = (missingPool: boolean) => {
      const draft = exactFixedInput();
      const coverage = draft.dexLiqMap.alpha!.exitRouteObservationCoverage!;
      // One missing exact-capability pool among thousands of diagnostic rows
      // has no admitted liquidity share. Counts cannot certify immateriality.
      coverage.retainedPoolCount = 10_000;
      coverage.scoreEligibleCapabilityPoolCount = missingPool ? 2 : 1;
      coverage.scoreEligiblePoolCount = 1;
      coverage.unsupportedPoolCount = missingPool ? 9_999 : 9_998;
      coverage.unsupportedReasons = {
        "nonExecutableEvidence:discovery-pool-shaped": 9_998,
        ...(missingPool ? { "executionCapabilityGate:measured-execution:quote-failed": 1 } : {}),
      };
      const fixed = rebuildFixed(draft);
      const reviewed = extension({ registryFingerprint: fixed.registryFingerprint });
      const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
      const evaluated = evaluateV9Exit({
        circulatingUsd: asset.supply.circulatingUsd,
        gaps: asset.gaps,
        portfolioFactStatus: asset.exitStatus,
        routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
      }, V9_CANDIDATE_POLICY_V1);
      return { asset, evaluated };
    };
    const complete = run(false);
    const missing = run(true);
    const gapId = "alpha:gap:exit-portfolio-coverage";
    expect(complete.asset.gaps.map((gap) => gap.gapId)).not.toContain(gapId);
    expect(missing.asset.gaps.find((gap) => gap.gapId === gapId)).toMatchObject({
      reasonCode: "incomplete-dex-route-coverage",
      causeProof: { cause: "U" },
    });
    expect(missing.asset.exitStatus.observationState).toBe("bounded-unknown");
    expect(missing.evaluated.causeGapIds).toContain(gapId);
    // The absent pool produces neither a synthetic route nor numeric capacity.
    expect(missing.asset.exitRoutes).toEqual(complete.asset.exitRoutes);
    expect(missing.evaluated.routes.map((route) => route.capacityPoint))
      .toEqual(complete.evaluated.routes.map((route) => route.capacityPoint));
  });

  it("keeps the DEX coverage label documentation without making it an Exit witness", () => {
    const run = (missingPool: boolean) => {
      const draft = exactFixedInput();
      const coverage = draft.dexLiqMap.alpha!.exitRouteObservationCoverage!;
      coverage.retainedPoolCount = 10_000;
      coverage.scoreEligibleCapabilityPoolCount = missingPool ? 2 : 1;
      coverage.scoreEligiblePoolCount = 1;
      coverage.unsupportedPoolCount = missingPool ? 9_999 : 9_998;
      coverage.unsupportedReasons = {
        "nonExecutableEvidence:discovery-pool-shaped": 9_998,
        ...(missingPool ? { "executionCapabilityGate:measured-execution:quote-failed": 1 } : {}),
      };
      const fixed = rebuildFixed(draft);
      const reviewed = extension({ registryFingerprint: fixed.registryFingerprint });
      const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
      return {
        asset: factSet.assets[0]!,
        evaluated: evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets[0]!,
      };
    };
    const complete = run(false);
    const missing = run(true);
    const gapId = "alpha:gap:exit-portfolio-coverage";
    const gap = missing.asset.gaps.find((candidate) => candidate.gapId === gapId)!;
    expect(classifyV9DocumentationGap(V9_CANDIDATE_POLICY_V1, missing.asset, gap)?.reason)
      .toBe("coverage-label");

    // The datum is an inventory witness, never a limiting one for any pillar.
    expect(missing.evaluated.exit.causeGapIds).toContain(gapId);
    for (const { evaluated } of [complete, missing]) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        expect(evaluated.scoreInput.pillars[pillar].limitingCauseGapIds ?? []).not.toContain(gapId);
      }
    }
    // Pricing never reads coverage, so the scored Exit pillar is identical.
    expect(missing.evaluated.scoreInput.pillars.exit.score)
      .toBe(complete.evaluated.scoreInput.pillars.exit.score);
    // The suffix in presentation is the disclosure; the verified class never moves the score.
    expect(missing.evaluated.score).toBe(complete.evaluated.score);
  });

  it("keeps the DEX portfolio denominator and cause independent of fee-only changes", () => {
    const assetId = "usdc-circle";
    const run = (costModel: RedemptionBackstopConfig["costModel"], observedPools: number) => {
      const draft = exactFixedInput({ assetId, clockSec: Date.UTC(2026, 6, 13) / 1_000 });
      draft.redemptionBackstopMap = {
        [assetId]: makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: null, updatedAt: draft.clockSec }),
      };
      draft.redemptionStale = false;
      draft.redemptionGenerationId = "redemption:fee-only-fixture";
      draft.inputFreshness.redemptionBackstops = { updatedAt: draft.clockSec, ageSeconds: 0, stale: false };
      const coverage = draft.dexLiqMap[assetId]!.exitRouteObservationCoverage!;
      if (observedPools === 2) {
        draft.dexLiqMap[assetId]!.exitRouteObservations!.push(
          v9ExitRouteObservation("dex:secondary", draft.clockSec - 100, "ethereum", draft.clockSec, "dex:secondary"),
        );
      }
      coverage.observationCount = observedPools;
      coverage.scoreEligibleObservationCount = observedPools;
      coverage.evidenceCounts = { "reserve-based-amm-simulation": observedPools };
      coverage.retainedPoolCount = 2;
      coverage.scoreEligibleCapabilityPoolCount = 2;
      coverage.scoreEligiblePoolCount = observedPools;
      coverage.unsupportedPoolCount = 2 - observedPools;
      coverage.unsupportedReasons = observedPools === 1
        ? { "executionCapabilityGate:measured-execution:quote-failed": 1 }
        : {};
      const fixed = rebuildFixed(draft);
      return withRedemptionBackstopConfig(assetId, {
        costModel, v9RouteCostTerms: undefined, v9RouteReviewTerms: undefined,
      }, () => {
        const reviewed = extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
        reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
        reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
        const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
        const asset = compiled.assets[0]!;
        const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
        return {
          causeGapIds: evaluated.exit.causeGapIds,
          portfolioGap: asset.gaps.find((gap) => gap.gapId === `${assetId}:gap:exit-portfolio-coverage`),
          redemption: asset.exitRoutes.find((route) => route.lane === "redemption")!,
        };
      });
    };
    const unknownFee: RedemptionBackstopConfig["costModel"] = {
      kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed",
    };
    for (const observedPools of [1, 2]) {
      const before = run(unknownFee, observedPools);
      const after = run(fixedFee(0), observedPools);
      expect(before.redemption.factorStatuses.cost!.observationState).toBe("missing");
      expect(before.causeGapIds).toEqual(expect.arrayContaining(before.redemption.factorStatuses.cost!.gapIds));
      expect(after.redemption.capacityCurve.every((point) => point.executionCostBps === 0)).toBe(true);
      expect(after.redemption.factorStatuses.cost!.observationState).toBe("known");
      for (const gapId of before.redemption.factorStatuses.cost!.gapIds) {
        expect(after.causeGapIds).not.toContain(gapId);
      }
      expect(after.portfolioGap).toEqual(before.portfolioGap);
      if (observedPools === 1) {
        expect(after.portfolioGap?.reasonCode).toBe("incomplete-dex-route-coverage");
        expect(before.causeGapIds).toContain(`${assetId}:gap:exit-portfolio-coverage`);
        expect(after.causeGapIds).toContain(`${assetId}:gap:exit-portfolio-coverage`);
      } else {
        expect(after.portfolioGap).toBeUndefined();
        expect(before.causeGapIds).not.toContain(`${assetId}:gap:exit-portfolio-coverage`);
        expect(after.causeGapIds).not.toContain(`${assetId}:gap:exit-portfolio-coverage`);
      }
    }
  });

  it.each([
    "deploymentCensusUnsupportedMethod",
    "deploymentCensusProviderOutage",
    "deploymentCensusNonExhaustiveProvider",
    "nonExecutableEvidence:defillama-pool-shaped",
    "executionCapabilityGate:curve-stableswap:rate-bearing-inputs",
    "executionCapabilityGate:measured-execution:target-unresolved",
  ])("does not upgrade the legacy %s coverage counter into pipeline proof", (unsupportedReason) => {
    for (const withRedemptionRoute of [false, true]) {
      const original = withRedemptionRoute ? queuedRedemptionFixedInput() : exactFixedInput();
      const census = unsupportedReason.startsWith("deploymentCensus");
      const fixed = rebuildFixed({
        ...original,
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservations: [],
            exitRouteObservationCoverage: {
              ...original.dexLiqMap.alpha!.exitRouteObservationCoverage!,
              status: census ? "unknown" : "unsupported",
              retainedPoolCount: census ? 0 : 4,
              observationCount: 0,
              scoreEligibleObservationCount: 0,
              scoreEligiblePoolCount: 0,
              scoreEligibleCapabilityPoolCount: 0,
              unsupportedPoolCount: census ? 0 : 4,
              evidenceCounts: {},
              unsupportedReasons: { [unsupportedReason]: 1 },
            },
          },
        },
      });
      const reviewed = extension();
      reviewed.assets[0]!.routeReviews = [];
      const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
      const asset = factSet.assets[0]!;
      const gap = asset.gaps.find((entry) => entry.gapId ===
        (withRedemptionRoute ? "alpha:gap:exit-portfolio-coverage" : "alpha:gap:exit-routes"));
      // Counters are useful diagnostics, not exact-generation reader verdicts.
      expect(gap).toMatchObject({ causeProof: { cause: "U" } });
      const queue = buildV9EvidenceGapQueue({ factSet, policy: V9_CANDIDATE_POLICY_V1 });
      expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
      const result = evaluateV9Exit({
        circulatingUsd: asset.supply.circulatingUsd,
        gaps: asset.gaps, portfolioFactStatus: asset.exitStatus,
        routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.aggregationDisposition).toBe("included");
    }
  });

});

describe("cause-bound Exit compiler admission", () => {
  it.each([
    { evidenceKind: "measured-executable-depth" as const, tier: "live-direct" as const },
    { evidenceKind: "direct-orderbook-depth" as const, tier: "live-direct" as const },
    { evidenceKind: "reserve-based-amm-simulation" as const, tier: "heuristic" as const },
  ])("retains established fresh $evidenceKind capacity without a missing-method discount", ({ evidenceKind, tier }) => {
    const draft = structuredClone(exactFixedInput());
    const observation = draft.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = evidenceKind;
    observation.capacityEvidenceTier = "unknown";
    observation.observedAt = draft.clockSec;
    if (evidenceKind === "direct-orderbook-depth") observation.routeFamily = "dex-orderbook";
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    for (const route of reviewed.assets[0]!.routeReviews) route.modelConfidence = "high";
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    const route = asset.exitRoutes.find((route) => route.lane === "dex")!;
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]).toMatchObject({ included: true, capacityEvidenceTier: tier, confidenceFactor: 1,
      confidenceDimensions: { capacityMethod: { factor: 1, cause: null, causeGapIds: [] } } });
  });

  it("does not let a recognized measured method revive stale DEX capacity", () => {
    const draft = structuredClone(exactFixedInput({ clockSec: 20_000 }));
    const observation = draft.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = "measured-executable-depth";
    observation.observedAt = 1;
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension({ clockSec: fixed.clockSec }));
    reviewed.registryFingerprint = fixed.registryFingerprint;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    const route = asset.exitRoutes.find((route) => route.lane === "dex")!;
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]).toMatchObject({ included: false, score: null, capacityPoint: null,
      exclusionReason: "missing-runtime-route-evidence" });
  });

  it.each([true, false])("retains queue/proxy confidence with an explicit tier: %s", (explicitTier) => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, false));
    const row = draft.redemptionBackstopMap.alpha!;
    row.capacityKind = "live-queue";
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    if (explicitTier) observation.capacityEvidenceTier = "live-queue-proxy";
    else delete observation.capacityEvidenceTier;
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    const route = asset.exitRoutes.find((route) => route.lane === "redemption")!;
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]!.confidenceDimensions).toMatchObject({
      observation: { factor: 1 }, model: { factor: 1 }, capacityMethod: { factor: 0.75 },
    });
    expect(result.routes[0]).toMatchObject({ capacityEvidenceTier: "live-queue-proxy",
      queueDepthUsd: 1_500_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000 });
    expect(route.settlementModel).toBe("queued");
    expect(route.scoreEligible).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });

  it("retains a stale captured observation as diagnostic A rather than executable current capacity", () => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, true));
    draft.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!.observedAt = draft.clockSec - 501;
    const fixed = rebuildFixed(draft);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    const route = asset.exitRoutes.find((route) => route.lane === "redemption")!;
    const capacityGap = asset.gaps.find((gap) => route.status.gapIds.includes(gap.gapId))!;
    expect(capacityGap.causeProof).toMatchObject({ cause: "A",
      sourceGenerationId: fixed.redemptionGenerationId });
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", limitedEvidenceCauses: [] });
    expect(result.routes[0]).toMatchObject({ score: null, included: false, capacityPoint: null });
  });

  it("rejects the entire 65-route reader inventory with scoped A proof and retains the last diagnostic", () => {
    const queue = queuedRedemptionFixedInput(300, true);
    const observation = queue.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
    const redemptionReview = buildSafetyScoreV9RouteReviews(queue, "alpha").find((route) => route.lane === "redemption")!;
    const fixed = exactFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    const retained = Array.from({ length: 65 }, (_, index) => ({
      lane: "redemption" as const, observation: { ...structuredClone(observation),
        routeId: `redemption:alpha:${String(index).padStart(2, "0")}` },
      disposition: "observed" as const, rejection: null,
    }));
    reviewed.assets[0]!.retainedRoutes = retained;
    reviewed.assets[0]!.routeReviews = [...reviewed.assets[0]!.routeReviews,
      ...retained.map((route) => ({ ...structuredClone(redemptionReview), routeId: route.observation.routeId }))];
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    const overflow = asset.gaps.find((gap) => gap.causeProof.cause === "A" &&
      gap.causeProof.rejectionCode === "route-inventory-over-limit")!;
    expect(overflow.causeScope).toMatchObject({ pillar: "exit", componentKey: "exit-routes", requiredDatum: "route-inventory" });
    expect(overflow.causeProof).toMatchObject({ cause: "A", producerState: "unsupported-reader",
      sourceGenerationId: fixed.sourceGeneration });
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute) }, V9_CANDIDATE_POLICY_V1);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b",
      primaryRouteKey: null, diversificationRouteKey: null, supportedComponentKeys: [] });
    const last = asset.exitRoutes.find((route) => route.routeId === "redemption:alpha:64")!;
    expect(result.routes.find((route) => route.routeKey === last.routeKey)).toMatchObject({
      score: null, included: false, capacityPoint: null, cause: "A", effectiveScoringWeight: 0,
    });
  });
});

describe("rejected-source route factor exclusion", () => {
  it.each([false, true])("keeps rejected runtime factors non-known with a reviewed route: %s", (withReview) => {
    const queue = queuedRedemptionFixedInput(300, true);
    const observation = structuredClone(queue.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!);
    observation.routeId = "redemption:alpha:rejected";
    observation.capacityEvidenceTier = "live-direct";
    const fixed = exactFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.retainedRoutes = [{ lane: "redemption", observation, disposition: "rejected",
      rejection: { code: "captured-reader-rejected", reason: "The captured producer rejected this route.", rejectedAtSec: fixed.clockSec } }];
    if (withReview) {
      const route = buildSafetyScoreV9RouteReviews(queue, "alpha").find((route) => route.lane === "redemption")!;
      reviewed.assets[0]!.routeReviews.push({ ...route, routeId: observation.routeId });
    }
    const normalized = normalizeSafetyScoreV9CompilerInput(fixed);
    const compiled = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(normalized,
      materializeSafetyScoreV9FactSetExtension(normalized, reviewed));
    expect(compiled.quarantines).toEqual([]);
    const asset = compiled.factSet.assets[0]!;
    const route = asset.exitRoutes.find((route) => route.routeId === observation.routeId)!;
    for (const factorKey of ["capacity", "observationConfidence", "cost", "capacityEvidenceTier"] as const) {
      const status = route.factorStatuses[factorKey]!;
      expect(status.observationState).not.toBe("known");
      const gap = asset.gaps.find((gap) => status.gapIds.includes(gap.gapId))!;
      expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "captured-reader-rejected" });
      expect(gap.causeScope).toMatchObject({ routeKey: route.routeKey, factorKey, requiredDatum: factorKey });
    }
    const result = evaluateV9Exit({ circulatingUsd: asset.supply.circulatingUsd, gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus, routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b" });
    expect(result.routes[0]).toMatchObject({ included: false, capacityPoint: null });
  });
});

describe("compiled Control causal minimum regressions", () => {
  it.each([
    { reconciliation: "internal-ledger" as const, cap: "unbounded" as const, supervision: "none" as const, missingWholeSupply: true },
    { reconciliation: "continuous" as const, cap: "unbounded" as const, supervision: "none" as const, missingWholeSupply: false },
    { reconciliation: "internal-ledger" as const, cap: "bounded" as const, supervision: "none" as const, missingWholeSupply: false },
    { reconciliation: "internal-ledger" as const, cap: "unbounded" as const, supervision: "prudential" as const, missingWholeSupply: false },
  ])("scopes whole-supply absence only to $reconciliation/$cap/$supervision", ({ reconciliation, cap, supervision, missingWholeSupply }) => {
    const fixed = exactFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    const overlay = reviewed.assets[0]!;
    overlay.controlReview = { state: "reviewed-controls", controls: [{
      controlKey: "mint:issuer", deploymentKey: "ethereum:issuer", controlKind: "mint", scope: "global",
      capabilities: ["mint"], capSemantics: { kind: cap, bound: cap === "bounded" ? { amount: 0.1, unit: "supply-fraction" } : null },
      claimImpairment: cap, economicLossScope: "global-claim",
      authority: { authorityKey: "ethereum:issuer", model: "eoa", threshold: null },
      delaySec: null, materialSupplyShare: null, keyCustody: "unknown", modulesOrGuards: "unknown",
      incidentState: "none", failureDomains: [{ kind: "mint-control", key: "ethereum:issuer" }],
    }] };
    overlay.economicControlReview!.mint = {
      status: v9Status("known", "v9.control.mint-review"), controlKey: "mint:issuer", reconciliation, supervision,
      latestResolvedIncidentAtSec: null, upgrade: { state: "not-applicable", controlKey: null },
    };
    const normalized = normalizeSafetyScoreV9CompilerInput(fixed);
    const compiled = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(normalized,
      materializeSafetyScoreV9FactSetExtension(normalized, reviewed));
    expect(compiled.quarantines).toEqual([]);
    const asset = compiled.factSet.assets[0]!;
    const result = evaluateV9EconomicControl({ facts: asset, ...asset.economicControlReview, policy: V9_CANDIDATE_POLICY_V1 });
    const mint = result.components.find((component) => component.kind === "mint")!;
    if (missingWholeSupply) {
      const status = asset.economicControlReview.mint.factorStatuses!.reconciliation!;
      expect(status.observationState).not.toBe("known");
      const gap = asset.gaps.find((gap) => status.gapIds.includes(gap.gapId))!;
      expect(gap.causeScope).toMatchObject({ pillar: "control", componentKey: "economic-control:mint",
        factorKey: "reconciliation", requiredDatum: "reconciliation" });
      expect(mint).toMatchObject({ score: 50, cause: "U", causeGapIds: [gap.gapId], scoringDisposition: "bounded-uncertainty" });
    } else {
      expect(mint).toMatchObject({ cause: null, scoringDisposition: "included" });
    }
    expect(result.score).toBe(Math.min(...result.components
      .filter((component) => component.binding && component.score !== null).map((component) => component.score!)));
  });
});

describe("direct exit fact builder", () => {

  it("reports absent exit observations as missing, not a known zero-exit market", () => {
    const fixed = exactFixedInput({ includeDexObservations: false, includeDexCoverage: false });
    const reviewed = extension({ registryFingerprint: fixed.registryFingerprint });
    reviewed.assets[0]!.routeReviews = [];
    const context = factBuilderContext(fixed, reviewed);
    const result = buildRoutes(context, buildSupply(context));
    expect(result.exitRoutes).toEqual([]);
    expect(result.exitStatus.observationState).toBe("missing");
    expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({
      reasonCode: "missing-runtime-route-evidence", observationState: "missing",
    }));
  });

  it("rejects a review for an observation that was not captured", () => {
    const fixed = exactFixedInput();
    const reviewed = extension({ registryFingerprint: fixed.registryFingerprint });
    reviewed.assets[0]!.routeReviews.push(routeReview("dex:absent"));
    const context = factBuilderContext(fixed, reviewed);
    expect(() => buildRoutes(context, buildSupply(context)))
      .toThrow(/Route reviews do not match captured observations/);
  });
});
