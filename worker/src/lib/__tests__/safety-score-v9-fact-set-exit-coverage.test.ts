/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { buildV9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
} from "@shared/lib/safety-score-v9/exit";
import { evaluateV9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control";
import {
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
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
  v9Status,
} from "../../test-helpers/v9-fixed-input";

describe("Safety Score v9 exact base fact-set adapter — exit and DEX coverage", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it.each([201, 4900])("re-admits a reviewed %s bps cost as zero within the request budget without quarantine", (costBps) => {
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
    expect(result.score).toBe(emptyDex ? V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore : 0);
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
    expect(exit.horizons.immediate).toEqual({ primaryRouteKey: null, score: null });
    expect(exit.horizons.queued.primaryRouteKey).toBe(redemption.routeKey);
    expect(exit.routes[0]).toMatchObject({
      horizon: "queued",
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

    // Unproven settlement remains a bounded C/U Exit floor; it is no longer a
    // final-score named ceiling.
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(evaluated.exit.reasons).toContain("unproven-settlement-bound");
    expect(evaluated.exit.reasons).not.toContain("no-viable-exit-path");
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
    const fixed = boundedUnknownFeeRedemptionFixedInput();
    const reviewed = structuredClone(extension());
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
    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "redemption-rail", key: "frax" });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "dex-protocol", key: "frax" });
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
              capabilityMatrixVersion: "p4a.9",
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

  it.each([
    "deploymentCensusUnsupportedMethod",
    "deploymentCensusProviderOutage",
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

  it("transports a same-run queue/proxy tier without clearing its queue, limits or eligibility", () => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, false));
    draft.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!.capacityEvidenceTier = "live-queue-proxy";
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
      queueDepthUsd: 1_500_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000,
      eligibilityMultiplier: 0.9 });
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
    const result = evaluateV9EconomicControlAssetFacts(asset, { assetId: asset.assetId, ...asset.economicControlReview },
      V9_CANDIDATE_POLICY_V1);
    const mint = result.components.find((component) => component.kind === "mint")!;
    if (missingWholeSupply) {
      const status = asset.economicControlReview.mint.factorStatuses!.reconciliation!;
      expect(status.observationState).not.toBe("known");
      const gap = asset.gaps.find((gap) => status.gapIds.includes(gap.gapId))!;
      expect(gap.causeScope).toMatchObject({ pillar: "control", componentKey: "economic-control:mint",
        factorKey: "reconciliation", requiredDatum: "reconciliation" });
      expect(mint).toMatchObject({ score: 25, cause: "U", causeGapIds: [gap.gapId], scoringDisposition: "bounded-uncertainty" });
    } else {
      expect(mint).toMatchObject({ cause: null, scoringDisposition: "included" });
    }
    expect(result.score).toBe(Math.min(...result.components
      .filter((component) => component.binding && component.score !== null).map((component) => component.score!)));
  });
});
