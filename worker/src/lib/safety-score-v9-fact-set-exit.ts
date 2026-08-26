import { z } from "zod";
import { resolvedExitRouteOutputAssetKeys } from "@shared/lib/exit-route-output";
import { isDexExitRouteCoverageWithinRouteBudget } from "@shared/lib/p4-exit-route-capacity";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import {
  createV9FactGapV3,
  optionalExitV9Path,
} from "@shared/lib/safety-score-v9/reasons";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type {
  V9EvidenceResponsibility,
  V9ExitRouteFactV2,
  V9FactGapV3,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "@shared/types/safety-score-v9-facts";
import type {
  ExitRouteObservation,
  ExitRouteObservationCoverage,
} from "@shared/types/exit-route";
import { getDexMeasuredExecutionFreshnessMaxSec } from "@shared/types/measured-execution";
import {
  RejectionSchema,
  RouteOutputReviewSchema,
  RouteReviewSchema,
  RouteValuationSchema,
} from "./safety-score-v9-fact-set-schema";
import {
  addEvidence,
  addGap,
  missingLocalFact,
  stableFailureDomains,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";

function scopeFailureDomains(
  observation: ExitRouteObservation,
  lane: "dex" | "redemption",
): V9FailureDomainRef[] {
  const scope = observation.scope;
  if (scope.kind === "chain-contract") {
    return [
      { kind: "chain", key: scope.chain },
      {
        kind: lane === "dex" ? "dex-protocol" : "redemption-rail",
        key: scope.protocol,
      },
    ];
  }
  if (scope.kind === "venue") return [{ kind: "dex-protocol", key: scope.protocol }];
  if (scope.kind === "issuer") return [{ kind: "redemption-rail", key: scope.issuerId }];
  return [
    { kind: "redemption-rail", key: scope.protocol },
    ...(scope.chain ? [{ kind: "chain" as const, key: scope.chain }] : []),
  ];
}

function routeEvidence(
  context: AssetBuildContext,
  lane: "dex" | "redemption",
  observation: ExitRouteObservation,
  disposition: "observed" | "rejected",
  rejection: z.infer<typeof RejectionSchema> | null,
  retained: boolean,
): string {
  const generationId = lane === "dex" ? context.fixedInput.dexGenerationId : context.fixedInput.redemptionGenerationId;
  // Documented-terms evidence lives on the review cadence the policy states
  // (semantic.exit.documentedTermsMaxAgeSec), not the producer cron cadence.
  const maxAgeSec =
    lane === "dex"
      ? observation.evidenceKind === "measured-executable-depth"
        ? Math.max(
            context.extension.routeFreshness.dexMaxAgeSec,
            getDexMeasuredExecutionFreshnessMaxSec(observation.adapterProfileId ?? ""),
          )
        : context.extension.routeFreshness.dexMaxAgeSec
      : observation.evidenceKind === "documented-terms"
        ? context.extension.routeFreshness.documentedTermsMaxAgeSec
        : context.extension.routeFreshness.redemptionMaxAgeSec;
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:route:${lane}:${observation.routeId}:${retained ? "retained" : "base"}`,
        sourceId: retained ? "safety-score-v9-retained-route-overlay" : `report-cards-${lane}-route-observation`,
        sourceGenerationId: retained ? context.extension.sources.researchOverlays.generationId : generationId,
        disposition,
        observedAtSec: observation.observedAt,
        contentSha256: domainDigest("safety-score-v9.route-observation.v1", observation),
        maxAgeSec,
        rejection,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function executionCostKey(point: { requestedNotionalUsd: number; maxCostBps: number }): string {
  return `${point.maxCostBps}:${point.requestedNotionalUsd}`;
}

function outputValuationEvidence(
  context: AssetBuildContext,
  routeKey: string,
  valuation: z.infer<typeof RouteValuationSchema>,
): string {
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:route-valuation:${routeKey}`,
        sourceId: valuation.sourceId,
        sourceGenerationId: valuation.sourceGenerationId,
        disposition: "observed",
        observedAtSec: valuation.observedAtSec,
        url: valuation.url,
        contentSha256: valuation.contentSha256,
        maxAgeSec: valuation.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function resolvedBaseRouteOutput(observation: ExitRouteObservation): {
  kind: "tracked-stablecoin" | "fiat" | "collateral";
  assetKeys: string[];
} | null {
  const output = observation.output;
  if (output.kind !== "tracked-stablecoin" && output.kind !== "fiat" && output.kind !== "collateral") return null;
  const assetKeys = resolvedExitRouteOutputAssetKeys(output);
  return assetKeys ? { kind: output.kind, assetKeys } : null;
}

function assertRouteOutputReviewMatchesBase(
  assetId: string,
  routeKey: string,
  observation: ExitRouteObservation,
  review: z.infer<typeof RouteOutputReviewSchema> | null,
): void {
  const base = resolvedBaseRouteOutput(observation);
  if (!base || !review) return;
  if (base.kind !== review.kind || stableJsonStringifyV1(base.assetKeys) !== stableJsonStringifyV1(review.assetKeys)) {
    throw new Error(`Route output review conflicts with exact base facts for ${assetId}:${routeKey}`);
  }
}

function routeGap(
  context: AssetBuildContext,
  routeKey: string,
  suffix: string,
  observationState: Exclude<V9FactStatusV2["observationState"], "known">,
  reasonCode: V9FactGapV3["reasonCode"],
  responsibility: V9EvidenceResponsibility,
  message: string,
  evidenceRefIds: readonly string[],
): string {
  return addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:route:${routeKey}:${suffix}`,
      reasonCode,
      ownerDomain: "exit",
      policyRuleId: suffix === "output" ? "v9.exit.output-valuation" : "v9.exit.same-notional-route",
      observationState,
      responsibility,
      path: optionalExitV9Path(routeKey),
      message,
      evidenceRefIds,
    }),
  );
}

function buildRoute(
  context: AssetBuildContext,
  args: {
    lane: "dex" | "redemption";
    observation: ExitRouteObservation;
    review: z.infer<typeof RouteReviewSchema> | undefined;
    disposition: "observed" | "rejected";
    rejection: z.infer<typeof RejectionSchema> | null;
    retained: boolean;
  },
): V9ExitRouteFactV2 {
  const generationId =
    args.lane === "dex" ? context.fixedInput.dexGenerationId : context.fixedInput.redemptionGenerationId;
  const routeKey = canonicalV9RouteKey(args.lane, generationId, args.observation.routeId);
  const evidenceId = routeEvidence(
    context,
    args.lane,
    args.observation,
    args.disposition,
    args.rejection,
    args.retained,
  );
  const evidence = context.evidence.get(evidenceId)!;
  const baseDomains = scopeFailureDomains(args.observation, args.lane);

  if (!args.review) {
    const gapId = routeGap(
      context,
      routeKey,
      "semantics",
      args.disposition === "rejected" ? "unsupported" : "bounded-unknown",
      "unsupported-same-notional-route",
      args.disposition === "rejected" ? "method-unsupported" : "integration-missing",
      "The base observation lacks reviewed v9 access, execution-cost, settlement, resource, and output semantics.",
      [evidenceId],
    );
    const status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.exit.same-notional-route"),
      observationState: args.disposition === "rejected" ? "unsupported" : "bounded-unknown",
      evidenceRefIds: [evidenceId],
      gapIds: [gapId],
    });
    return {
      routeKey,
      routeId: args.observation.routeId,
      lane: args.lane,
      sourceGenerationId: generationId,
      routeFamily: args.observation.routeFamily,
      holderAccess: "unknown",
      executionModel: "unknown",
      executionCertainty: "unknown",
      modelConfidence: "low",
      observationConfidence: args.observation.confidence,
      observationHistory: args.observation.observationHistory ?? null,
      evidenceKind: args.observation.evidenceKind,
      ...(args.observation.feeEvidence ? { feeEvidence: args.observation.feeEvidence } : {}),
      coverageClass: "diagnostic",
      capacityScoringHorizon: "unknown",
      settlementModel: "unknown",
      settlementSlaSec: null,
      queueDepthUsd: null,
      dailyLimitUsd: null,
      minRedeemUsd: null,
      settlementEvidenceRefIds: [],
      physicalResourceKeys: [],
      status,
      scoreEligible: false,
      settlementBoundUnproven: args.observation.settlementBoundUnproven === true,
      request: null,
      capacityCurve: [],
      output: {
        status,
        kind: "unknown",
        assetKeys: [],
        basketWeights: [],
        valuation: null,
      },
      failureDomains: baseDomains,
    };
  }

  const costByKey = new Map(args.review.executionCosts.map((point) => [executionCostKey(point), point]));
  const rawCurve = args.observation.capacityCurve ?? [
    {
      requestedNotionalUsd: args.observation.requestedNotionalUsd,
      maxCostBps: args.observation.maxCostBps,
      executableUsd: args.observation.executableUsd,
      completionRatio: args.observation.completionRatio,
    },
  ];
  const capacityCurve = rawCurve.map((point) => {
    const cost = costByKey.get(executionCostKey(point));
    if (!cost) throw new Error(`Missing execution cost for ${context.asset.assetId}:${routeKey}`);
    costByKey.delete(executionCostKey(point));
    return { ...point, executionCostBps: cost.executionCostBps };
  });
  if (costByKey.size > 0) throw new Error(`Unmatched execution costs for ${context.asset.assetId}:${routeKey}`);

  let routeState: V9FactStatusV2["observationState"] = "known";
  if (args.disposition === "rejected") routeState = "unsupported";
  else if (evidence.freshness.state === "stale") routeState = "stale";
  const routeGapId =
    routeState === "known"
      ? null
      : routeGap(
          context,
          routeKey,
          routeState === "stale" ? "stale" : "rejected",
          routeState,
          routeState === "stale" ? "missing-runtime-route-evidence" : "unsupported-same-notional-route",
          routeState === "stale" ? "producer-failed" : "method-unsupported",
          routeState === "stale"
            ? "The retained route observation is older than the lane freshness bound."
            : "The retained route observation was rejected by its producer or review process.",
          [evidenceId],
        );
  const routeStatus = createV9FactStatus({
    applicability: requiredV9Applicability("v9.exit.same-notional-route"),
    observationState: routeState,
    evidenceRefIds: [evidenceId],
    gapIds: routeGapId ? [routeGapId] : [],
  });

  assertRouteOutputReviewMatchesBase(context.asset.assetId, routeKey, args.observation, args.review.output);

  let output: V9ExitRouteFactV2["output"];
  if (args.disposition === "rejected") {
    output = {
      status: routeStatus,
      kind: "unknown",
      assetKeys: [],
      basketWeights: [],
      valuation: null,
    };
  } else if (!args.review.output?.valuation) {
    const outputResponsibility =
      args.review.output !== null
        ? "producer-failed"
        : (args.review.unresolvedOutputResponsibility ?? "integration-missing");
    const gapId = routeGap(
      context,
      routeKey,
      "output",
      "missing",
      "unresolved-exit-output",
      outputResponsibility,
      "The route output does not have an explicit same-notional USD valuation.",
      [evidenceId],
    );
    output = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.exit.output-valuation"),
        observationState: "missing",
        evidenceRefIds: [],
        gapIds: [gapId],
      }),
      kind: args.review.output?.kind ?? "unknown",
      assetKeys: args.review.output?.assetKeys ?? [],
      basketWeights: args.review.output?.basketWeights ?? [],
      valuation: null,
    };
  } else {
    const reviewOutput = args.review.output;
    const valuationInput = reviewOutput.valuation!;
    const valuationEvidenceId = outputValuationEvidence(context, routeKey, valuationInput);
    const valuationEvidence = context.evidence.get(valuationEvidenceId)!;
    const outputState = valuationEvidence.freshness.state === "stale" ? "stale" : "known";
    const outputGapId =
      outputState === "stale"
        ? routeGap(
            context,
            routeKey,
            "output",
            "stale",
            "unresolved-exit-output",
            "producer-failed",
            "The last-known route output valuation is older than its freshness bound.",
            [valuationEvidenceId],
          )
        : null;
    output = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.exit.output-valuation"),
        observationState: outputState,
        evidenceRefIds: [valuationEvidenceId],
        gapIds: outputGapId ? [outputGapId] : [],
      }),
      kind: reviewOutput.kind,
      assetKeys: reviewOutput.assetKeys,
      basketWeights: reviewOutput.basketWeights,
      valuation: {
        basis: valuationInput.basis,
        referenceAssetKey: valuationInput.referenceAssetKey,
        unitValueUsd: valuationInput.unitValueUsd,
        expectedUnitValueUsd: valuationInput.expectedUnitValueUsd,
        valueRetentionRatio: valuationInput.unitValueUsd / valuationInput.expectedUnitValueUsd,
        sourceId: valuationInput.sourceId,
        sourceGenerationId: valuationInput.sourceGenerationId,
        observedAtSec: valuationInput.observedAtSec,
        asOfSec: context.fixedInput.clockSec,
        confidence: valuationInput.confidence,
        freshness: valuationEvidence.freshness,
        evidenceRefIds: [valuationEvidenceId],
      },
    };
  }

  // Producer eligibility is evaluated against the captured route semantics.
  // V9 reviews may conservatively worsen those semantics (for example, an
  // atomic producer route can become an unbounded queue), so re-apply the
  // score-bearing contract after the review has been materialized.
  const reviewedSemanticsAreScoreable =
    args.review.holderAccess !== "unknown" &&
    args.review.executionModel !== "unknown" &&
    args.review.executionCertainty !== "unknown" &&
    args.observation.confidence !== "unknown" &&
    args.review.settlementModel !== "unknown" &&
    args.review.physicalResourceKeys.length > 0 &&
    (args.review.settlementModel === "atomic" || args.review.settlementSlaSec !== null);
  const scoreEligible =
    args.observation.scoreEligible &&
    routeState === "known" &&
    output.status.observationState === "known" &&
    args.review.coverageClass !== "diagnostic" &&
    reviewedSemanticsAreScoreable;
  return {
    routeKey,
    routeId: args.observation.routeId,
    lane: args.lane,
    sourceGenerationId: generationId,
    routeFamily: args.observation.routeFamily,
    holderAccess: args.review.holderAccess,
    executionModel: args.review.executionModel,
    executionCertainty: args.review.executionCertainty,
    modelConfidence: args.review.modelConfidence,
    observationConfidence: args.observation.confidence,
    observationHistory: args.observation.observationHistory ?? null,
    evidenceKind: args.observation.evidenceKind,
    ...(args.observation.feeEvidence ? { feeEvidence: args.observation.feeEvidence } : {}),
    coverageClass: args.review.coverageClass,
    capacityScoringHorizon: args.review.capacityScoringHorizon ?? "unknown",
    settlementModel: args.review.settlementModel,
    settlementSlaSec: args.review.settlementSlaSec,
    queueDepthUsd: args.review.queueDepthUsd ?? null,
    dailyLimitUsd: args.review.dailyLimitUsd ?? null,
    minRedeemUsd: args.review.minRedeemUsd ?? null,
    settlementEvidenceRefIds: [evidenceId],
    physicalResourceKeys: args.review.physicalResourceKeys,
    status: routeStatus,
    scoreEligible,
    settlementBoundUnproven: args.observation.settlementBoundUnproven === true,
    request: {
      requestedNotionalUsd: args.observation.requestedNotionalUsd,
      maxCostBps: args.observation.maxCostBps,
      settlementHorizonSec: Math.max(
        args.observation.settlementHorizonSec,
        args.review.settlementHorizonSec ?? 0,
      ),
    },
    capacityCurve,
    output,
    failureDomains: stableFailureDomains([...baseDomains, ...args.review.failureDomains]),
  };
}

/**
 * Owner rulings 2026-07-29 (R1-A / R1-B / R4 scope). A DEX exit surface can be
 * uncovered for two structurally different reasons, and only one of them is a
 * producer failure:
 *
 * - `census-unsupported`: the deployment census could not certify the asset's
 *   footprint because at least one deployment chain has no registered discovery
 *   provider (`deploymentCensusUnsupportedMethod`). Pharos has no method for
 *   that chain — nothing failed. The remaining census reasons (provider outage,
 *   unscheduled scope, pools lost between discovery and scoring, invalid or
 *   stale outcomes) are genuine producer failures and stay `producer-failed`.
 * - `no-exact-capable-venue`: retained pools exist, but no adapter family in the
 *   capability matrix recognises any of them and no capability gate is holding
 *   one back — or the only remaining gates are reviewed model limits (rate-
 *   bearing inputs, unsupported invariants, metapools, paused/swap-disabled
 *   pools). That is `method-unsupported`. Construction/delivery gates
 *   (`target-unresolved`, `quote-missing`, `quote-failed`) stay producer-failed.
 *
 * Everything else keeps the producer attribution.
 */
type V9DexSurfaceUnsupportedKind = "census-unsupported" | "no-exact-capable-venue";

const MODEL_UNSUPPORTED_GATE_FRAGMENTS = [
  "unsupported-invariant",
  "rate-bearing-inputs",
  "metapool-unsupported",
  "paused-or-swap-disabled",
] as const;

function isModelUnsupportedCapabilityGate(reason: string): boolean {
  if (!reason.startsWith("executionCapabilityGate:")) return false;
  return MODEL_UNSUPPORTED_GATE_FRAGMENTS.some((fragment) => reason.includes(fragment));
}

function classifyUnsupportedDexSurface(
  coverage: ExitRouteObservationCoverage | undefined,
): V9DexSurfaceUnsupportedKind | null {
  if (coverage == null) return null;
  if (coverage.retainedPoolCount === 0) {
    return (coverage.unsupportedReasons["deploymentCensusUnsupportedMethod"] ?? 0) > 0
      ? "census-unsupported"
      : null;
  }
  // `scoreEligibleCapabilityPoolCount` is optional: an absent count proves
  // nothing about the venue set, so it must fail closed to producer attribution.
  const capabilityGates = Object.keys(coverage.unsupportedReasons).filter((reason) =>
    reason.startsWith("executionCapabilityGate:"),
  );
  const heldByCapabilityGate = capabilityGates.length > 0;
  if (coverage.scoreEligibleCapabilityPoolCount === 0 && !heldByCapabilityGate) {
    return "no-exact-capable-venue";
  }
  // 9.2: a recognised venue whose only remaining gates are reviewed model
  // limits is a method floor, not a feed failure.
  if (
    heldByCapabilityGate &&
    capabilityGates.every(isModelUnsupportedCapabilityGate) &&
    (coverage.scoreEligiblePoolCount ?? 0) === 0
  ) {
    return "no-exact-capable-venue";
  }
  return null;
}

export function buildRoutes(context: AssetBuildContext): {
  exitStatus: V9FactStatusV2;
  exitRoutes: V9ExitRouteFactV2[];
} {
  const reviewByKey = new Map(context.asset.routeReviews.map((review) => [`${review.lane}:${review.routeId}`, review]));
  const consumedReviews = new Set<string>();
  const observations: Array<{
    lane: "dex" | "redemption";
    observation: ExitRouteObservation;
    disposition: "observed" | "rejected";
    rejection: z.infer<typeof RejectionSchema> | null;
    retained: boolean;
  }> = [];
  const dexRows = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservations ?? [];
  observations.push(
    ...dexRows.map((observation) => ({
      lane: "dex" as const,
      observation,
      disposition: "observed" as const,
      rejection: null,
      retained: false,
    })),
  );
  const redemptionRows =
    context.fixedInput.redemptionBackstopMap[context.asset.assetId]?.capacityProfile?.exitRouteObservations ?? [];
  observations.push(
    ...redemptionRows.map((observation) => ({
      lane: "redemption" as const,
      observation,
      disposition: "observed" as const,
      rejection: null,
      retained: false,
    })),
  );
  observations.push(
    ...context.asset.retainedRoutes.map((row) => ({
      lane: row.lane,
      observation: row.observation,
      disposition: row.disposition,
      rejection: row.rejection,
      retained: true,
    })),
  );
  observations.sort(
    (left, right) =>
      compareText(left.lane, right.lane) ||
      compareText(left.observation.routeId, right.observation.routeId) ||
      Number(left.retained) - Number(right.retained),
  );
  const routeKeys = observations.map((row) => `${row.lane}:${row.observation.routeId}`);
  const duplicate = routeKeys.find((key, index) => routeKeys.indexOf(key) !== index);
  if (duplicate) throw new Error(`Duplicate base or retained v9 route for ${context.asset.assetId}:${duplicate}`);

  const routes = observations.map((row) => {
    const reviewKey = `${row.lane}:${row.observation.routeId}`;
    const review = reviewByKey.get(reviewKey);
    if (review) consumedReviews.add(reviewKey);
    return buildRoute(context, { ...row, review });
  });
  const unconsumedReviews = [...reviewByKey.keys()].filter((key) => !consumedReviews.has(key));
  if (unconsumedReviews.length > 0) {
    throw new Error(
      `Route reviews do not match captured observations for ${context.asset.assetId}: ${unconsumedReviews}`,
    );
  }
  if (routes.length === 0) {
    // A reviewed-complete DEX surface with zero retained pools and no
    // redemption row is KNOWN negative evidence (score-defined zero exit),
    // not missing evidence; missing is reserved for incomplete coverage
    // (VER-006).
    const emptyCoverage = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservationCoverage;
    const emptySurfaceComplete =
      emptyCoverage != null &&
      emptyCoverage.status === "populated" &&
      emptyCoverage.retainedPoolCount === 0 &&
      emptyCoverage.unsupportedPoolCount === 0;
    if (emptySurfaceComplete) {
      // Known-empty negative evidence must carry the DEX producer's observation
      // time, not the scoring clock: a stale empty surface is not a current
      // "known" zero-exit fact but a bounded-unknown/stale one (VER2-007). Fresh
      // populated 0/0 coverage remains known negative evidence (exit 0).
      const coverageEvidenceId = addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${context.asset.assetId}:exit-route-observation-coverage`,
            sourceId: "report-cards-dex-route-observation",
            sourceGenerationId: context.fixedInput.dexGenerationId,
            disposition: "observed",
            observedAtSec: context.fixedInput.dexLiqMap[context.asset.assetId]!.updatedAt,
            contentSha256: domainDigest("safety-score-v9.exit-route-observation-coverage.v1", emptyCoverage),
            maxAgeSec: context.extension.routeFreshness.dexMaxAgeSec,
          },
          context.fixedInput.clockSec,
        ),
      );
      const coverageStale = context.evidence.get(coverageEvidenceId)!.freshness.state === "stale";
      const staleGapId = coverageStale
        ? addGap(
            context,
            createV9FactGapV3({
              gapId: `${context.asset.assetId}:gap:exit-route-observation-coverage:stale`,
              reasonCode: "missing-runtime-route-evidence",
              ownerDomain: "exit",
              policyRuleId: "v9.exit.same-notional-route",
              observationState: "stale",
              responsibility: "producer-failed",
              path: { kind: "local-component", componentKey: "exit-routes" },
              message: "The known-empty DEX exit-route coverage observation is older than the lane freshness bound.",
              evidenceRefIds: [coverageEvidenceId],
            }),
          )
        : null;
      return {
        exitStatus: createV9FactStatus({
          applicability: requiredV9Applicability("v9.exit.same-notional-route"),
          observationState: coverageStale ? "stale" : "known",
          evidenceRefIds: [coverageEvidenceId],
          gapIds: staleGapId ? [staleGapId] : [],
        }),
        exitRoutes: [],
      };
    }
    // R4 scope (owner ruling 2026-07-29): a zero-route surface whose census
    // could not certify the footprint for lack of any registered discovery
    // provider is not a producer failure.
    // SUPERSEDED in part 2026-08-12: that condition is an integration gap, not a
    // method limit. The chain has deployments and markets; Pharos has no
    // provider wired for it, which is our gap and is tractable. Same attribution
    // as the portfolio-coverage branch so one condition cannot publish two
    // different responsibilities.
    // The reason code stays `missing-runtime-route-evidence` because it is the
    // only registered exit code whose policy `pathKinds` admit a
    // `local-component` path; `unsupported-same-notional-route` is registered
    // for `optional-exit` only, and emitting it here would stamp every
    // reclassified gap `path-kind-not-permitted` in the evidence queue. The
    // `unsupported` observation state plus the explicit responsibility already
    // carry the ruling; the code swap rides the v9.04 policy bump.
    if (classifyUnsupportedDexSurface(emptyCoverage) === "census-unsupported") {
      return {
        exitStatus: missingLocalFact(context, {
          componentKey: "exit-routes",
          reasonCode: "missing-runtime-route-evidence",
          ownerDomain: "exit",
          responsibility: "integration-missing",
          policyRuleId: "v9.exit.same-notional-route",
          message:
            "The deployment census carries no registered discovery provider for at least one deployment chain, so no same-notional exit route can be observed.",
          observationState: "unsupported",
        }).status,
        exitRoutes: [],
      };
    }
    return {
      exitStatus: missingLocalFact(context, {
        componentKey: "exit-routes",
        reasonCode: "missing-runtime-route-evidence",
        ownerDomain: "exit",
        responsibility: "producer-failed",
        policyRuleId: "v9.exit.same-notional-route",
        message: "No exact DEX, redemption, or retained route observation is available.",
      }).status,
      exitRoutes: [],
    };
  }
  const statuses = routes.flatMap((route) => [route.status, route.output.status]);
  const gapIds = [...new Set(statuses.flatMap((status) => status.gapIds))];
  const evidenceRefIds = [...new Set(statuses.flatMap((status) => status.evidenceRefIds))];
  // "known" asserts the whole exit surface is observed (it upgrades evidence
  // level and arms the reviewed-complete zero-score path), so it additionally
  // requires every budget-admitted score-eligible DEX capability pool to carry
  // an observation; capability pools omitted solely by the bounded route-
  // selection budget stay out of the denominator per the 2026-07-27 owner
  // ruling. Structurally non-executable shaped rows remain diagnostics.
  // A portfolio holding only diagnostic routes over an incompletely observed
  // DEX surface stays bounded-unknown. A missing redemption row does not
  // demote the state: absent redemption evidence can only understate the
  // score, and the zero-score path still requires an observed portfolio.
  const coverage = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservationCoverage;
  // "known" upgrades the exit surface and arms the reviewed-complete zero-score
  // path, so it requires populated DEX coverage. An `unknown`/`unsupported`
  // surface stays bounded-unknown even when its retained-pool count is zero: a
  // score-ineligible diagnostic route must never certify unobserved coverage
  // nor let evidence arrival drop the score below the bounded-unknown floor
  // (VER2-006).
  const dexSurfaceComplete =
    coverage != null &&
    coverage.status === "populated" &&
    (coverage.retainedPoolCount === 0 || isDexExitRouteCoverageWithinRouteBudget(coverage));
  const portfolioGapIds = [...gapIds];
  if (!dexSurfaceComplete) {
    // R1-A / R1-B (owner ruling 2026-07-29). The legacy single message asserted
    // that reviewed execution-capability pools exist but are unobserved, which
    // is false for a surface with zero retained pools: there is nothing that
    // "does not all carry" an observation. Attribution and message now follow
    // the surface's actual shape, and the bounded-unknown observation state is
    // unchanged so the exit floor does not move.
    const unsupportedSurface = classifyUnsupportedDexSurface(coverage);
    portfolioGapIds.push(
      addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:exit-portfolio-coverage`,
          // `incomplete-dex-route-coverage` is the registered exit code for a
          // `local-component` aggregate path; see the zero-route branch for why
          // the `unsupported-same-notional-route` swap waits on the policy bump.
          reasonCode: "incomplete-dex-route-coverage",
          ownerDomain: "exit",
          policyRuleId: "v9.exit.same-notional-route",
          observationState: "bounded-unknown",
          // RULED 2026-08-12. A chain the census carries no registered discovery
          // provider for is a Pharos integration gap, not a method floor: the
          // deployments and markets exist, we have not wired a provider for them.
          // Publishing `method-unsupported` there told readers the data cannot
          // exist when it demonstrably does. `no-exact-capable-venue` is the
          // genuine method limit and keeps its attribution.
          responsibility:
            unsupportedSurface === null
              ? "producer-failed"
              : unsupportedSurface === "census-unsupported"
                ? "integration-missing"
                : "method-unsupported",
          path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
          message:
            unsupportedSurface === "census-unsupported"
              ? "The deployment census carries no registered discovery provider for at least one deployment chain, so the DEX exit surface could not be certified."
              : unsupportedSurface === "no-exact-capable-venue"
                ? "No reviewed execution model recognizes any retained pool, so this asset has no exact-capable DEX venue."
                : coverage != null && coverage.retainedPoolCount === 0
                  ? "The deployment census could not certify this asset's DEX footprint, so no reviewed execution-capability pool exists."
                  : "Reviewed DEX execution-capability pools do not all carry score-eligible exact route observations.",
          evidenceRefIds,
        }),
      ),
    );
  }
  return {
    exitStatus: createV9FactStatus({
      applicability: requiredV9Applicability("v9.exit.same-notional-route"),
      observationState: portfolioGapIds.length > 0 ? "bounded-unknown" : "known",
      evidenceRefIds,
      gapIds: portfolioGapIds,
    }),
    exitRoutes: routes,
  };
}
