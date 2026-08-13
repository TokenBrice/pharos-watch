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
import {
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
} from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9BoundedUnknownFeeRedemptionFixedInput as boundedUnknownFeeRedemptionFixedInput,
  makeV9FixedInput as exactFixedInput,
  makeV9Extension as extension,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9RouteReview as routeReview,
} from "../../test-helpers/v9-fixed-input";

describe("Safety Score v9 exact base fact-set adapter — exit and DEX coverage", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
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

  it("preserves reviewed capacity and applies the bounded-unknown fee ceiling end to end", () => {
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
        routes: [projectV9ExitEvaluationRoute(redemption)],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const ceiling = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.undisclosedFeeRouteScoreCeiling;
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.score).toBeLessThanOrEqual(ceiling);
    expect(exit.routes[0]).toMatchObject({
      included: true,
      capsApplied: expect.arrayContaining(["fee-evidence:undisclosed-reviewed"]),
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

    const {
      schemaVersion: omittedSchemaVersion,
      dexPayloadFingerprint: omittedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
      registryFingerprint: omittedRegistryFingerprint,
      inputMethodologyVersions: omittedInputMethodologyVersions,
      baseInputGenerationId: omittedBaseInputGenerationId,
      ...draft
    } = fixed;
    void [
      omittedSchemaVersion,
      omittedDexPayloadFingerprint,
      omittedRedemptionPayloadFingerprint,
      omittedRegistryFingerprint,
      omittedInputMethodologyVersions,
      omittedBaseInputGenerationId,
    ];
    const rebuilt = createReportCardsFixedInput(draft);
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
      const {
        schemaVersion: omittedSchemaVersion,
        activeAssetIds: omittedActiveAssetIds,
        dexPayloadFingerprint: omittedDexPayloadFingerprint,
        redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
        registryFingerprint: omittedRegistryFingerprint,
        inputMethodologyVersions: omittedInputMethodologyVersions,
        baseInputGenerationId: omittedBaseInputGenerationId,
        ...draft
      } = original;
      void [
        omittedSchemaVersion,
        omittedActiveAssetIds,
        omittedDexPayloadFingerprint,
        omittedRedemptionPayloadFingerprint,
        omittedRegistryFingerprint,
        omittedInputMethodologyVersions,
        omittedBaseInputGenerationId,
      ];
      return createReportCardsFixedInput({
        ...draft,
        activeAssetIds: ["alpha"],
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservationCoverage: {
              status: "populated",
              capabilityMatrixVersion: "p4a.8",
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

  // Owner rulings R1-A / R1-B / R4 (2026-07-29). Only a producer that could
  // have delivered may be blamed for an uncovered DEX exit surface.
  it("splits an uncovered DEX exit surface between method limits and producer failures", () => {
    // Every cohort here has an empty DEX observation set: cohort A has no
    // reviewed pool at all, cohort B has retained pools that no execution model
    // recognises. Whether a portfolio gap or the zero-route branch fires then
    // depends only on whether another lane carries a route.
    const withCoverage = (
      coverage: Partial<
        NonNullable<ReturnType<typeof exactFixedInput>["dexLiqMap"][string]["exitRouteObservationCoverage"]>
      >,
      options: { withRedemptionRoute?: boolean } = {},
    ) => {
      const original = options.withRedemptionRoute ? queuedRedemptionFixedInput() : exactFixedInput();
      const {
        schemaVersion: omittedSchemaVersion,
        dexPayloadFingerprint: omittedDexPayloadFingerprint,
        redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
        registryFingerprint: omittedRegistryFingerprint,
        inputMethodologyVersions: omittedInputMethodologyVersions,
        baseInputGenerationId: omittedBaseInputGenerationId,
        ...draft
      } = original;
      void [
        omittedSchemaVersion,
        omittedDexPayloadFingerprint,
        omittedRedemptionPayloadFingerprint,
        omittedRegistryFingerprint,
        omittedInputMethodologyVersions,
        omittedBaseInputGenerationId,
      ];
      return createReportCardsFixedInput({
        ...draft,
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservations: [],
            exitRouteObservationCoverage: {
              ...original.dexLiqMap.alpha!.exitRouteObservationCoverage!,
              observationCount: 0,
              scoreEligibleObservationCount: 0,
              scoreEligiblePoolCount: 0,
              evidenceCounts: {},
              ...coverage,
            },
          },
        },
      });
    };
    const reviewedWithoutDexRoutes = () => {
      const reviewed = extension();
      reviewed.assets[0]!.routeReviews = [];
      return reviewed;
    };
    const portfolioGap = (fixed: ReturnType<typeof exactFixedInput>) =>
      compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewedWithoutDexRoutes()).assets[0]!.gaps.find(
        (gap) => gap.gapId === "alpha:gap:exit-portfolio-coverage",
      );

    // R1-A: no reviewed pool exists at all because a deployment chain has no
    // registered discovery provider. The legacy message claimed reviewed
    // capability pools were unobserved, which is false for a zero-pool surface.
    const censusUnsupported = portfolioGap(
      withCoverage({
        status: "unknown",
        retainedPoolCount: 0,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: {},
        unsupportedReasons: { deploymentCensusUnsupportedMethod: 1 },
      }, { withRedemptionRoute: true }),
    );
    expect(censusUnsupported).toMatchObject({
      reasonCode: "incomplete-dex-route-coverage",
      // RULED 2026-08-12: no registered discovery provider is a Pharos
      // integration gap, not a method floor.
      responsibility: "integration-missing",
      observationState: "bounded-unknown",
    });
    expect(censusUnsupported!.message).not.toContain("do not all carry");

    // The other census reasons ARE producer failures and keep that attribution,
    // but they still stop asserting reviewed capability pools they do not have.
    const providerOutage = portfolioGap(
      withCoverage({
        status: "unknown",
        retainedPoolCount: 0,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: {},
        unsupportedReasons: { deploymentCensusProviderOutage: 1 },
      }, { withRedemptionRoute: true }),
    );
    expect(providerOutage).toMatchObject({
      reasonCode: "incomplete-dex-route-coverage",
      responsibility: "producer-failed",
    });
    expect(providerOutage!.message).not.toContain("do not all carry");

    // R1-B: retained pools exist, but no reviewed execution model recognises
    // any of them and nothing is gated — Pharos has no method for this venue.
    const noExactCapableVenue = portfolioGap(
      withCoverage({
        status: "unsupported",
        retainedPoolCount: 4,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: 0,
        unsupportedPoolCount: 4,
        unsupportedReasons: { "nonExecutableEvidence:defillama-pool-shaped": 4 },
      }, { withRedemptionRoute: true }),
    );
    expect(noExactCapableVenue).toMatchObject({
      reasonCode: "incomplete-dex-route-coverage",
      responsibility: "method-unsupported",
    });

    // 9.2: a recognised venue whose only remaining gate is a reviewed model
    // limit (rate-bearing StableSwap) is a method floor, not a feed failure.
    expect(
      portfolioGap(
        withCoverage({
          status: "unsupported",
          retainedPoolCount: 4,
          scoreEligiblePoolCount: 0,
          scoreEligibleCapabilityPoolCount: 0,
          unsupportedPoolCount: 4,
          unsupportedReasons: { "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1 },
        }, { withRedemptionRoute: true }),
      ),
    ).toMatchObject({ reasonCode: "incomplete-dex-route-coverage", responsibility: "method-unsupported" });

    // A construction/delivery gate is still a producer failure.
    expect(
      portfolioGap(
        withCoverage({
          status: "unsupported",
          retainedPoolCount: 4,
          scoreEligiblePoolCount: 0,
          scoreEligibleCapabilityPoolCount: 0,
          unsupportedPoolCount: 4,
          unsupportedReasons: { "executionCapabilityGate:measured-execution:target-unresolved": 1 },
        }, { withRedemptionRoute: true }),
      ),
    ).toMatchObject({ reasonCode: "incomplete-dex-route-coverage", responsibility: "producer-failed" });

    // An absent capability count proves nothing about the venue set and must
    // fail closed to the producer.
    const unknownCapabilityCount = withCoverage(
      {
        status: "unsupported",
        retainedPoolCount: 4,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: undefined,
        unsupportedPoolCount: 4,
        unsupportedReasons: { "nonExecutableEvidence:defillama-pool-shaped": 4 },
      },
      { withRedemptionRoute: true },
    );
    expect(
      unknownCapabilityCount.dexLiqMap.alpha!.exitRouteObservationCoverage!.scoreEligibleCapabilityPoolCount,
    ).toBeUndefined();
    expect(portfolioGap(unknownCapabilityCount)).toMatchObject({
      reasonCode: "incomplete-dex-route-coverage",
      responsibility: "producer-failed",
    });

    // R4 scope: the same split on the zero-route branch, where no observation
    // of any lane exists to hang a portfolio gap on.
    const zeroRouteAsset = (fixed: ReturnType<typeof exactFixedInput>) =>
      compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewedWithoutDexRoutes()).assets[0]!;
    const zeroRouteCensusUnsupported = zeroRouteAsset(
      withCoverage(
        {
          status: "unknown",
          retainedPoolCount: 0,
          observationCount: 0,
          scoreEligibleObservationCount: 0,
          scoreEligiblePoolCount: 0,
          scoreEligibleCapabilityPoolCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: {},
          unsupportedReasons: { deploymentCensusUnsupportedMethod: 1 },
        },
      ),
    );
    expect(zeroRouteCensusUnsupported.exitRoutes).toEqual([]);
    expect(zeroRouteCensusUnsupported.exitStatus.observationState).toBe("unsupported");
    expect(zeroRouteCensusUnsupported.gaps).toContainEqual(
      expect.objectContaining({
        gapId: "alpha:gap:exit-routes",
        reasonCode: "missing-runtime-route-evidence",
        responsibility: "integration-missing",
        observationState: "unsupported",
      }),
    );

    const zeroRouteProviderOutage = zeroRouteAsset(
      withCoverage(
        {
          status: "unknown",
          retainedPoolCount: 0,
          observationCount: 0,
          scoreEligibleObservationCount: 0,
          scoreEligiblePoolCount: 0,
          scoreEligibleCapabilityPoolCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: {},
          unsupportedReasons: { deploymentCensusProviderOutage: 1 },
        },
      ),
    );
    expect(zeroRouteProviderOutage.gaps).toContainEqual(
      expect.objectContaining({
        gapId: "alpha:gap:exit-routes",
        reasonCode: "missing-runtime-route-evidence",
        responsibility: "producer-failed",
        observationState: "missing",
      }),
    );

    // Every reclassified gap must still bind cleanly to its policy entry. Only
    // `incomplete-dex-route-coverage` and `missing-runtime-route-evidence` are
    // registered for a `local-component` exit path; swapping in a code that is
    // not would silently reroute the whole cohort to `reconcile-policy-binding`
    // instead of its owner. This pins the constraint the v9.04 reason-code
    // rename has to satisfy.
    const censusUnsupportedCoverage = {
      status: "unknown" as const,
      retainedPoolCount: 0,
      scoreEligibleCapabilityPoolCount: 0,
      unsupportedPoolCount: 0,
      unsupportedReasons: { deploymentCensusUnsupportedMethod: 1 },
    };
    for (const fixed of [
      withCoverage(censusUnsupportedCoverage, { withRedemptionRoute: true }),
      withCoverage(censusUnsupportedCoverage),
    ]) {
      const queue = buildV9EvidenceGapQueue({
        factSet: compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewedWithoutDexRoutes()),
        policy: V9_CANDIDATE_POLICY_V1,
      });
      expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
    }
  });

});
