import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import {
  isUsdDenominatedSupplyKind,
  type V9FactStatusV2,
  type V9AssetFactsV3,
} from "../../types/safety-score-v9-facts";
import {
  V9_RELEASE_COVERAGE_FLOORS,
  V9CoverageEvaluationProjectionPayloadV1Schema,
  V9CoverageEvaluationSnapshotV1Schema,
  V9ReleaseCohortManifestV1Schema,
  V9ReleaseCoverageReportV1Schema,
  type V9CoverageBlockerCode,
  type V9CoverageBlockerV1,
  type V9CoverageEvaluationSnapshotV1,
  type V9CoverageEvaluationProjectionPayloadV1,
  type V9ReleaseCohortAssetV1,
  type V9ReleaseCohortManifestV1,
  type V9ReleaseCoverageReportV1,
} from "../../types/safety-score-v9-coverage";
import type { MechanismArchetype } from "../../types/stablecoin-taxonomy";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { readCompiledV9FactSetForEvaluation } from "./facts";
import { compareText, deepFreeze } from "./primitives";

const V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN = "safety-score-v9.release-coverage-report.v1";
const V9_COVERAGE_EVALUATION_PROJECTION_DIGEST_DOMAIN = "safety-score-v9.coverage-evaluation-projection.v1";

const REVIEW_DOMAINS = ["backing", "control", "access", "peg", "supply", "implementation"] as const;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolvedArchetype(value: V9AssetFactsV3["archetype"]): MechanismArchetype | null {
  return value === "unresolved" ? null : value;
}

function ratioBps(numerator: number, denominator: number, zeroDenominatorPass: boolean): number | null {
  if (denominator === 0) return zeroDenominatorPass ? 10_000 : null;
  return Math.min(10_000, Math.floor((numerator * 10_000) / denominator));
}

function meetsRatio(numerator: number, denominator: number, minimumBps: number, zeroDenominatorPass: boolean): boolean {
  if (denominator === 0) return zeroDenominatorPass;
  return numerator * 10_000 >= denominator * minimumBps;
}

function evidenceCurrent(asset: V9AssetFactsV3, evidenceRefIds: readonly string[]): boolean {
  if (evidenceRefIds.length === 0) return false;
  const byId = new Map(asset.evidence.map((reference) => [reference.evidenceId, reference]));
  return evidenceRefIds.every((evidenceId) => {
    const evidence = byId.get(evidenceId);
    return evidence?.disposition !== "rejected" && evidence?.freshness.state === "current";
  });
}

function applicabilityReviewed(status: V9FactStatusV2): boolean {
  return status.applicability.state !== "unresolved";
}

function statusCurrent(asset: V9AssetFactsV3, status: V9FactStatusV2): boolean {
  return (
    applicabilityReviewed(status) &&
    status.observationState === "known" &&
    evidenceCurrent(asset, status.evidenceRefIds)
  );
}

function mechanismStatuses(asset: V9AssetFactsV3): V9FactStatusV2[] {
  if (asset.mechanismRiskReview.review === null) return [];
  return Object.values(asset.mechanismRiskReview.review).flatMap((value) =>
    value !== null && typeof value === "object" && "status" in value
      ? [(value as { status: V9FactStatusV2 }).status]
      : [],
  );
}

interface ReviewState {
  applicabilityReviewed: boolean;
  currentComplete: boolean;
}

function reviewState(asset: V9AssetFactsV3, domain: (typeof REVIEW_DOMAINS)[number]): ReviewState {
  let statuses: readonly V9FactStatusV2[];
  let structuralComplete = true;
  if (domain === "backing") {
    statuses = [
      asset.mechanismRiskReview.status,
      ...mechanismStatuses(asset),
      asset.reserveStatus,
      ...asset.reserveExposures.map((exposure) => exposure.status),
    ];
    structuralComplete =
      asset.mechanismRiskReview.status.applicability.state === "not-applicable" ||
      asset.mechanismRiskReview.review !== null;
  } else if (domain === "control") {
    statuses = [
      asset.controlStatus,
      ...asset.controls.map((control) => control.status),
      asset.economicControlReview.mint.status,
      asset.economicControlReview.oracle.status,
      ...asset.economicControlReview.oracle.branches.map((branch) => branch.status),
      asset.economicControlReview.bridge.status,
    ];
  } else if (domain === "access") {
    statuses = [
      asset.accessReview.transfer.status,
      asset.accessReview.freeze.status,
      ...asset.accessReview.freeze.reviews.map((review) => review.status),
    ];
  } else if (domain === "peg") {
    statuses = [asset.peg.status];
    structuralComplete =
      asset.peg.status.applicability.state === "not-applicable" ||
      (asset.peg.pegScore !== null && asset.peg.currentDeviationBps !== null && asset.peg.activeDepeg !== null);
  } else if (domain === "supply") {
    statuses = [asset.supply.status];
    structuralComplete =
      isUsdDenominatedSupplyKind(asset.supply.sourceKind) && asset.supply.circulatingUsd !== null;
  } else {
    statuses = [asset.implementation.status];
    structuralComplete = asset.implementation.launchedAtSec !== null;
  }
  return {
    applicabilityReviewed: statuses.every(applicabilityReviewed),
    currentComplete: structuralComplete && statuses.every((status) => statusCurrent(asset, status)),
  };
}

function reserveCoverage(asset: V9AssetFactsV3) {
  const sourceNative = asset.reserveExposures.filter(
    (exposure) => exposure.provenance === "live" && statusCurrent(asset, exposure.status),
  );
  const curated = asset.reserveExposures.filter((exposure) => exposure.provenance === "curated");
  const curatedFallback = asset.reserveExposures.filter((exposure) => exposure.provenance === "curated-fallback");
  const structured = asset.reserveExposures.filter(
    (exposure) =>
      statusCurrent(asset, exposure.status) && exposure.assetClass !== null && exposure.failureDomains.length > 0,
  );
  return {
    assetId: asset.assetId,
    exposureCount: asset.reserveExposures.length,
    sourceNativeExposureCount: sourceNative.length,
    curatedExposureCount: curated.length,
    curatedFallbackExposureCount: curatedFallback.length,
    structuredExposureCount: structured.length,
    unstructuredExposureCount: asset.reserveExposures.length - structured.length,
    totalExposureWeight: asset.reserveExposures.reduce((sum, exposure) => sum + exposure.weight, 0),
    sourceNativeExposureWeight: sourceNative.reduce((sum, exposure) => sum + exposure.weight, 0),
    structuredExposureWeight: structured.reduce((sum, exposure) => sum + exposure.weight, 0),
  };
}

function routeCoverage(asset: V9AssetFactsV3, lane: "dex" | "redemption", includedRouteKeys: ReadonlySet<string>) {
  const routes = asset.exitRoutes.filter((route) => route.lane === lane);
  const current = routes.filter((route) => statusCurrent(asset, route.status));
  const capabilityComplete = routes.filter(
    (route) =>
      route.scoreEligible &&
      route.coverageClass !== "diagnostic" &&
      route.request !== null &&
      route.capacityCurve.length > 0 &&
      route.physicalResourceKeys.length > 0 &&
      route.failureDomains.length > 0 &&
      route.settlementEvidenceRefIds.length > 0,
  );
  const outputResolved = routes.filter(
    (route) =>
      statusCurrent(asset, route.output.status) &&
      route.output.kind !== "unknown" &&
      route.output.assetKeys.length > 0 &&
      route.output.valuation !== null,
  );
  const valuationCurrent = routes.filter((route) => {
    const valuation = route.output.valuation;
    return (
      valuation !== null && valuation.freshness.state === "current" && evidenceCurrent(asset, valuation.evidenceRefIds)
    );
  });
  const exact = routes.filter((route) => route.coverageClass !== "diagnostic");
  const currentKeys = new Set(current.map((route) => route.routeKey));
  const capabilityKeys = new Set(capabilityComplete.map((route) => route.routeKey));
  const outputKeys = new Set(outputResolved.map((route) => route.routeKey));
  const valuationKeys = new Set(valuationCurrent.map((route) => route.routeKey));
  const contributing = routes.filter(
    (route) =>
      includedRouteKeys.has(route.routeKey) &&
      currentKeys.has(route.routeKey) &&
      capabilityKeys.has(route.routeKey) &&
      outputKeys.has(route.routeKey) &&
      valuationKeys.has(route.routeKey),
  );
  const keys = (values: typeof routes) => sortedUnique(values.map((route) => route.routeKey));
  return {
    assetId: asset.assetId,
    lane,
    routeKeys: keys(routes),
    scoreEligibleRouteKeys: keys(routes.filter((route) => route.scoreEligible)),
    exactCoverageRouteKeys: keys(exact),
    currentRouteKeys: keys(current),
    capabilityCompleteRouteKeys: keys(capabilityComplete),
    outputResolvedRouteKeys: keys(outputResolved),
    valuationCurrentRouteKeys: keys(valuationCurrent),
    v9ContributingRouteKeys: keys(contributing),
  };
}

function difference(left: readonly string[], right: ReadonlySet<string>): string[] {
  return left.filter((value) => !right.has(value)).sort(compareText);
}

function blockerSortKey(blocker: V9CoverageBlockerV1): string {
  return `${blocker.code}\u0000${blocker.assetId ?? ""}\u0000${blocker.archetype ?? ""}\u0000${blocker.message}`;
}

export function computeV9CoverageEvaluationProjectionDigest(
  projection: V9CoverageEvaluationProjectionPayloadV1 | V9CoverageEvaluationSnapshotV1,
): string {
  const { evaluationProjectionDigest: _evaluationProjectionDigest, ...payload } =
    projection as V9CoverageEvaluationSnapshotV1;
  const parsed = V9CoverageEvaluationProjectionPayloadV1Schema.parse(payload);
  return sha256Hex(
    stableJsonStringifyV1({ domain: V9_COVERAGE_EVALUATION_PROJECTION_DIGEST_DOMAIN, evaluation: parsed }),
  );
}

function currentCanonicalWeightMatches(
  asset: V9AssetFactsV3,
  manifestAsset: V9ReleaseCohortAssetV1,
  chainSupplyGenerationId: string,
  chainSupplyObservedAtSec: number,
): boolean {
  const weight = manifestAsset.weight;
  const factIsCurrentCanonical =
    statusCurrent(asset, asset.supply.status) &&
    isUsdDenominatedSupplyKind(asset.supply.sourceKind) &&
    asset.supply.circulatingUsd !== null &&
    asset.supply.sourceGenerationId === chainSupplyGenerationId;
  if (weight.disposition !== "current-valid") return !factIsCurrentCanonical;
  return (
    factIsCurrentCanonical &&
    weight.canonicalUsd === asset.supply.circulatingUsd &&
    weight.sourceGenerationId === chainSupplyGenerationId &&
    weight.observedAtSec === chainSupplyObservedAtSec
  );
}

function isTopEvidenceComplete(
  asset: V9AssetFactsV3,
  evaluation: V9CoverageEvaluationSnapshotV1["assets"][number] | undefined,
  routeAssets: readonly ReturnType<typeof routeCoverage>[],
): boolean {
  if (!evaluation || evaluation.finalScore === null) return false;
  const domainsComplete = REVIEW_DOMAINS.every((domain) => reviewState(asset, domain).currentComplete);
  if (!domainsComplete || !statusCurrent(asset, asset.dependencies.status) || !statusCurrent(asset, asset.exitStatus)) {
    return false;
  }
  if (evaluation.primaryExitRouteKey === null) return true;
  return routeAssets.some((coverage) => coverage.v9ContributingRouteKeys.includes(evaluation.primaryExitRouteKey!));
}

/** Evaluate the immutable V9-9 economic coverage floors without mutating facts or score output. */
export function evaluateV9ReleaseCoverage(args: {
  factSet: unknown;
  evaluation: V9CoverageEvaluationSnapshotV1;
  manifest: V9ReleaseCohortManifestV1;
}): Readonly<V9ReleaseCoverageReportV1> {
  const factSetRead = readCompiledV9FactSetForEvaluation(args.factSet);
  if (factSetRead.sourceSchemaVersion !== 3) {
    throw new Error(
      "Safety Score v9 release coverage requires a native V3 fact set; retained V2 facts must be replayed through the V3 compiler because the V1 coverage report has only one fact-set identity",
    );
  }
  const factSet = factSetRead.factSet;
  const evaluation = V9CoverageEvaluationSnapshotV1Schema.parse(args.evaluation);
  const manifest = V9ReleaseCohortManifestV1Schema.parse(args.manifest);
  const blockers: V9CoverageBlockerV1[] = [];
  const computedEvaluationProjectionDigest = computeV9CoverageEvaluationProjectionDigest(evaluation);
  const addBlocker = (
    condition: boolean,
    code: V9CoverageBlockerCode,
    message: string,
    assetId: string | null = null,
    archetype: MechanismArchetype | null = null,
  ): void => {
    if (condition) blockers.push({ code, assetId, archetype, message });
  };

  const factIds = [...factSet.activeAssetIds];
  const evaluationIds = evaluation.assets.map((asset) => asset.assetId);
  const manifestIds = manifest.assets.map((asset) => asset.assetId);
  const factIdSet = new Set(factIds);
  const evaluationIdSet = new Set(evaluationIds);
  const manifestIdSet = new Set(manifestIds);
  const exactBijection = sameStrings(factIds, evaluationIds) && sameStrings(factIds, manifestIds);
  const activeSet = {
    factCount: factIds.length,
    evaluationCount: evaluationIds.length,
    manifestCount: manifestIds.length,
    exactBijection,
    differences: {
      factOnly: sortedUnique(factIds.filter((id) => !evaluationIdSet.has(id) || !manifestIdSet.has(id))),
      evaluationOnly: difference(evaluationIds, factIdSet),
      manifestOnly: difference(manifestIds, factIdSet),
      missingFromEvaluation: difference(factIds, evaluationIdSet),
      missingFromManifest: difference(factIds, manifestIdSet),
    },
  };
  addBlocker(
    !exactBijection,
    "active-id-bijection-failed",
    "Fact, evaluator, and cohort active IDs are not bijective.",
  );

  const expectedSourceGenerations = Object.fromEntries(
    Object.entries(factSet.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([source, fingerprint]) => [source, fingerprint.generationId]),
  ) as V9CoverageEvaluationSnapshotV1["sourceGenerations"];
  const expectedSourceKeys = Object.keys(expectedSourceGenerations).sort(compareText);
  const evaluationSourceKeys = Object.keys(evaluation.sourceGenerations).sort(compareText);
  const sourceGenerationMatch =
    sameStrings(expectedSourceKeys, evaluationSourceKeys) &&
    expectedSourceKeys.every(
      (source) =>
        evaluation.sourceGenerations[source as keyof typeof evaluation.sourceGenerations] ===
        expectedSourceGenerations[source as keyof typeof expectedSourceGenerations],
    );
  const identityChecks = {
    factSetDigest:
      evaluation.factSetDigest === factSet.v9FactSetDigest &&
      manifest.bindings.factSetDigest === factSet.v9FactSetDigest,
    baseInputGenerationId:
      evaluation.baseInputGenerationId === factSet.baseInputGenerationId &&
      manifest.bindings.baseInputGenerationId === factSet.baseInputGenerationId,
    policyId: manifest.bindings.policyId === evaluation.policyId,
    policyDigest: manifest.bindings.policyDigest === evaluation.policyDigest,
    evaluationBuildDigest: manifest.bindings.evaluationBuildDigest === evaluation.evaluationBuildDigest,
    producerCapabilityDigest: manifest.bindings.producerCapabilityDigest === evaluation.producerCapabilityDigest,
    evaluationBuildCurrent: evaluation.evaluationBuildDigest === SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    evaluatedSetDigest: manifest.bindings.evaluatedSetDigest === evaluation.evaluatedSetDigest,
    scoreResultDigest: manifest.bindings.scoreResultDigest === evaluation.scoreResultDigest,
    evaluationProjectionDigest:
      evaluation.evaluationProjectionDigest === computedEvaluationProjectionDigest &&
      manifest.bindings.evaluationProjectionDigest === computedEvaluationProjectionDigest,
    registryDigest: manifest.bindings.registryPayloadDigest === factSet.sourceFingerprints.registry.payloadSha256,
    weightDigest: manifest.bindings.weightPayloadDigest === factSet.sourceFingerprints.chainSupply.payloadSha256,
    asOf: evaluation.asOfSec === factSet.asOfSec && manifest.capturedAtSec === factSet.asOfSec,
    sourceGenerations: sourceGenerationMatch,
  };
  addBlocker(!identityChecks.factSetDigest, "fact-set-digest-mismatch", "Fact-set identities do not match.");
  addBlocker(
    !identityChecks.baseInputGenerationId,
    "base-input-generation-mismatch",
    "Base input generation identities do not match.",
  );
  addBlocker(!identityChecks.policyId, "policy-id-mismatch", "Manifest policy ID does not match evaluation.");
  addBlocker(
    !identityChecks.policyDigest,
    "policy-digest-mismatch",
    "Manifest policy digest does not match evaluation.",
  );
  addBlocker(
    !identityChecks.evaluationBuildDigest,
    "evaluation-build-digest-mismatch",
    "Manifest evaluation build does not match evaluation.",
  );
  addBlocker(
    !identityChecks.producerCapabilityDigest,
    "producer-capability-digest-mismatch",
    "Manifest producer capability digest does not match evaluation.",
  );
  addBlocker(
    !identityChecks.evaluationBuildCurrent,
    "evaluation-build-not-current",
    "Evaluation build is not the current generated build.",
  );
  addBlocker(
    !identityChecks.evaluatedSetDigest,
    "evaluated-set-digest-mismatch",
    "Manifest evaluated-set digest does not match evaluation.",
  );
  addBlocker(
    !identityChecks.scoreResultDigest,
    "score-result-digest-mismatch",
    "Manifest score-result digest does not match evaluation.",
  );
  addBlocker(
    !identityChecks.evaluationProjectionDigest,
    "evaluation-projection-digest-mismatch",
    "Coverage evaluation projection does not match its frozen score and route commitment.",
  );
  addBlocker(
    !identityChecks.registryDigest,
    "registry-digest-mismatch",
    "Registry payload digest does not match facts.",
  );
  addBlocker(!identityChecks.weightDigest, "weight-digest-mismatch", "Weight payload digest does not match facts.");
  addBlocker(!identityChecks.asOf, "as-of-mismatch", "Fact, evaluator, and cohort clocks do not match.");
  addBlocker(
    !identityChecks.sourceGenerations,
    "source-generation-mismatch",
    "Evaluator source generations do not match facts.",
  );

  const factsById = new Map(factSet.assets.map((asset) => [asset.assetId, asset]));
  const evaluationById = new Map(evaluation.assets.map((asset) => [asset.assetId, asset]));
  const manifestById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const rateableIds = factIds.filter((assetId) => evaluationById.get(assetId)?.finalScore !== null);
  const rateableSet = new Set(rateableIds);
  // Coverage is evaluated against the active V9 set directly.
  const requiredRateableCount = Math.min(factIds.length, V9_RELEASE_COVERAGE_FLOORS.minimumRateableAssets);
  const rateabilityPassed = rateableIds.length >= requiredRateableCount;
  addBlocker(
    !rateabilityPassed,
    "rateable-asset-count-below-floor",
    `Rateable asset count ${rateableIds.length} is below required ${requiredRateableCount}.`,
  );

  const weightMismatchIds: string[] = [];
  const currentValidAssetIds: string[] = [];
  const missingAssetIds: string[] = [];
  const invalidAssetIds: string[] = [];
  const unboundedAssetIds: string[] = [];
  let boundedCanonicalWeightUsd = 0;
  let rateableCanonicalWeightUsd = 0;
  for (const assetId of factIds) {
    const asset = factsById.get(assetId)!;
    const manifestAsset = manifestById.get(assetId);
    addBlocker(
      asset.archetype === "unresolved",
      "unresolved-archetype",
      `Active asset ${assetId} has no resolved mechanism archetype.`,
      assetId,
    );
    if (!manifestAsset) {
      unboundedAssetIds.push(assetId);
      continue;
    }
    addBlocker(
      manifestAsset.archetype !== asset.archetype,
      "archetype-manifest-mismatch",
      `Manifest archetype does not match normalized facts for ${assetId}.`,
      assetId,
      resolvedArchetype(asset.archetype),
    );
    const matches = currentCanonicalWeightMatches(
      asset,
      manifestAsset,
      factSet.sourceFingerprints.chainSupply.generationId,
      factSet.sourceFingerprints.chainSupply.observedAtSec,
    );
    if (!matches) {
      weightMismatchIds.push(assetId);
      addBlocker(
        true,
        "canonical-weight-fact-mismatch",
        `Frozen canonical weight does not match current source-native supply facts for ${assetId}.`,
        assetId,
        resolvedArchetype(asset.archetype),
      );
    }
    const weight = manifestAsset.weight;
    if (weight.disposition === "current-valid") {
      currentValidAssetIds.push(assetId);
      boundedCanonicalWeightUsd += weight.canonicalUsd!;
      if (rateableSet.has(assetId) && matches) rateableCanonicalWeightUsd += weight.canonicalUsd!;
    } else {
      (weight.disposition === "missing" ? missingAssetIds : invalidAssetIds).push(assetId);
      if (weight.conservativeUpperBoundUsd === null) {
        unboundedAssetIds.push(assetId);
        addBlocker(
          true,
          "canonical-weight-unbounded",
          `Missing or invalid canonical weight has no conservative upper bound for ${assetId}.`,
          assetId,
          resolvedArchetype(asset.archetype),
        );
      } else {
        boundedCanonicalWeightUsd += weight.conservativeUpperBoundUsd;
      }
    }
  }
  const globalZeroWeightPass = factIds.every((assetId) => rateableSet.has(assetId));
  const rateableWeightBps = ratioBps(
    rateableCanonicalWeightUsd,
    boundedCanonicalWeightUsd,
    globalZeroWeightPass && unboundedAssetIds.length === 0,
  );
  const weightPassed =
    unboundedAssetIds.length === 0 &&
    weightMismatchIds.length === 0 &&
    meetsRatio(
      rateableCanonicalWeightUsd,
      boundedCanonicalWeightUsd,
      V9_RELEASE_COVERAGE_FLOORS.minimumRateableWeightBps,
      globalZeroWeightPass,
    );
  addBlocker(
    !weightPassed,
    "supply-weight-rateability-below-99-percent",
    "Bounded canonical supply weight does not prove 99% rateability.",
  );

  const validWeights = manifest.assets
    .filter((asset) => asset.weight.disposition === "current-valid")
    .map((asset) => ({ assetId: asset.assetId, weight: asset.weight.canonicalUsd! }))
    .sort((left, right) => right.weight - left.weight || compareText(left.assetId, right.assetId));
  const actualCutoffPosition = Math.min(V9_RELEASE_COVERAGE_FLOORS.topCutoffPosition, factIds.length);
  const cutoffUsd = validWeights.length >= actualCutoffPosition ? validWeights[actualCutoffPosition - 1]!.weight : null;
  const derivedTopIds =
    cutoffUsd === null
      ? []
      : sortedUnique(validWeights.filter((entry) => entry.weight >= cutoffUsd).map((entry) => entry.assetId));
  const manifestTopIds = sortedUnique(
    manifest.assets.filter((asset) => asset.weight.topCutoffMember).map((asset) => asset.assetId),
  );
  const ranksConsistent = validWeights.every(({ assetId, weight }) => {
    const expectedRank = 1 + validWeights.filter((entry) => entry.weight > weight).length;
    return manifestById.get(assetId)?.weight.rank === expectedRank;
  });
  const membershipConsistent = sameStrings(derivedTopIds, manifestTopIds);
  const topCutoffDeterminate =
    cutoffUsd !== null &&
    manifest.assets
      .filter((asset) => asset.weight.disposition !== "current-valid")
      .every(
        (asset) =>
          asset.weight.conservativeUpperBoundUsd !== null && asset.weight.conservativeUpperBoundUsd < cutoffUsd,
      ) &&
    derivedTopIds.every((assetId) => !weightMismatchIds.includes(assetId));
  addBlocker(!ranksConsistent, "manifest-rank-mismatch", "Frozen canonical weight ranks are inconsistent.");
  addBlocker(
    !membershipConsistent,
    "manifest-top-cutoff-membership-mismatch",
    "Frozen top-cutoff membership does not preserve all cutoff ties.",
  );
  addBlocker(!topCutoffDeterminate, "top-cutoff-indeterminate", "Canonical facts cannot prove the top-cutoff cohort.");

  const includedByAsset = new Map(
    evaluation.assets.map((asset) => [asset.assetId, new Set(asset.includedExitRouteKeys)]),
  );
  const routeAssets = factSet.assets
    .flatMap((asset) => [
      routeCoverage(asset, "dex", includedByAsset.get(asset.assetId) ?? new Set()),
      routeCoverage(asset, "redemption", includedByAsset.get(asset.assetId) ?? new Set()),
    ])
    .sort((left, right) => compareText(`${left.assetId}:${left.lane}`, `${right.assetId}:${right.lane}`));
  const routeCoverageByAsset = new Map<string, Array<(typeof routeAssets)[number]>>();
  for (const routeAsset of routeAssets) {
    routeCoverageByAsset.set(routeAsset.assetId, [...(routeCoverageByAsset.get(routeAsset.assetId) ?? []), routeAsset]);
  }
  const topCurrentValid = derivedTopIds.filter(
    (assetId) =>
      manifestById.get(assetId)?.weight.disposition === "current-valid" && !weightMismatchIds.includes(assetId),
  );
  const topRateable = derivedTopIds.filter((assetId) => rateableSet.has(assetId));
  const topEvidenceCompleteIds = derivedTopIds.filter((assetId) =>
    isTopEvidenceComplete(
      factsById.get(assetId)!,
      evaluationById.get(assetId),
      routeCoverageByAsset.get(assetId) ?? [],
    ),
  );
  for (const assetId of derivedTopIds) {
    const archetype = resolvedArchetype(factsById.get(assetId)!.archetype);
    addBlocker(
      !topCurrentValid.includes(assetId),
      "top-cutoff-weight-not-current-valid",
      `Top-cutoff asset ${assetId} lacks a current valid canonical weight.`,
      assetId,
      archetype,
    );
    addBlocker(
      !topRateable.includes(assetId),
      "top-cutoff-asset-not-rateable",
      `Top-cutoff asset ${assetId} is not rateable.`,
      assetId,
      archetype,
    );
    addBlocker(
      !topEvidenceCompleteIds.includes(assetId),
      "top-cutoff-evidence-incomplete",
      `Top-cutoff asset ${assetId} depends on incomplete or non-current score evidence.`,
      assetId,
      archetype,
    );
  }
  const topPassed =
    topCutoffDeterminate &&
    ranksConsistent &&
    membershipConsistent &&
    topCurrentValid.length === derivedTopIds.length &&
    topRateable.length === derivedTopIds.length &&
    topEvidenceCompleteIds.length === derivedTopIds.length;

  const calibrationRequiredIds = sortedUnique(
    manifest.assets
      .filter((asset) => asset.calibrationDisposition === "required-rateable")
      .map((asset) => asset.assetId),
  );
  const intentionalEvidenceGapIds = sortedUnique(
    manifest.assets
      .filter((asset) => asset.calibrationDisposition === "intentional-evidence-gap")
      .map((asset) => asset.assetId),
  );
  const calibrationMemberIds = sortedUnique([...calibrationRequiredIds, ...intentionalEvidenceGapIds]);
  const ratedRequiredIds = calibrationRequiredIds.filter((assetId) => rateableSet.has(assetId));
  const calibrationSizePassed = calibrationMemberIds.length === V9_RELEASE_COVERAGE_FLOORS.calibrationCohortAssets;
  const calibrationCompositionPassed =
    calibrationRequiredIds.length === V9_RELEASE_COVERAGE_FLOORS.calibrationRequiredRateableAssets &&
    intentionalEvidenceGapIds.length === V9_RELEASE_COVERAGE_FLOORS.calibrationIntentionalEvidenceGapAssets;
  const calibrationRateabilityPassed = ratedRequiredIds.length === calibrationRequiredIds.length;
  addBlocker(
    !calibrationSizePassed,
    "calibration-cohort-size-mismatch",
    "Calibration cohort does not contain exactly 24 active assets.",
  );
  addBlocker(
    !calibrationCompositionPassed,
    "calibration-cohort-composition-mismatch",
    "Calibration cohort does not contain 21 required and three intentional-gap assets.",
  );
  for (const assetId of calibrationRequiredIds.filter((id) => !rateableSet.has(id))) {
    addBlocker(
      true,
      "calibration-required-asset-not-rateable",
      `Required calibration asset ${assetId} is not rateable.`,
      assetId,
      factsById.has(assetId) ? resolvedArchetype(factsById.get(assetId)!.archetype) : null,
    );
  }

  const notRatedAssetIds = factIds.filter((assetId) => !rateableSet.has(assetId));
  const reviewedNrIds: string[] = [];
  const missingNrReviewIds: string[] = [];
  const reasonMismatchIds: string[] = [];
  for (const assetId of factIds) {
    const manifestAsset = manifestById.get(assetId);
    const evaluatedAsset = evaluationById.get(assetId);
    if (!manifestAsset || !evaluatedAsset) continue;
    if (evaluatedAsset.finalScore !== null) {
      addBlocker(
        manifestAsset.nrReview.state !== "not-required",
        "rateable-asset-has-nr-review",
        `Rateable asset ${assetId} carries an NR review.`,
        assetId,
        resolvedArchetype(factsById.get(assetId)!.archetype),
      );
      continue;
    }
    if (manifestAsset.nrReview.state !== "reviewed") {
      missingNrReviewIds.push(assetId);
      addBlocker(
        true,
        "nr-review-missing",
        `Not-rated asset ${assetId} lacks reviewed applicability and disposition.`,
        assetId,
        resolvedArchetype(factsById.get(assetId)!.archetype),
      );
      continue;
    }
    reviewedNrIds.push(assetId);
    if (!sameStrings(manifestAsset.nrReview.reasonCodes, evaluatedAsset.nrReasonCodes)) {
      reasonMismatchIds.push(assetId);
      addBlocker(
        true,
        "nr-reason-mismatch",
        `Reviewed reasons do not match evaluator NR reasons for ${assetId}.`,
        assetId,
        resolvedArchetype(factsById.get(assetId)!.archetype),
      );
    }
  }
  const nrReviewPassed =
    reviewedNrIds.length === notRatedAssetIds.length &&
    missingNrReviewIds.length === 0 &&
    reasonMismatchIds.length === 0;

  const reserveAssets = factSet.assets
    .map(reserveCoverage)
    .sort((left, right) => compareText(left.assetId, right.assetId));
  const reserveTotals = reserveAssets.reduce(
    (total, asset) => ({
      exposureCount: total.exposureCount + asset.exposureCount,
      sourceNativeExposureCount: total.sourceNativeExposureCount + asset.sourceNativeExposureCount,
      curatedExposureCount: total.curatedExposureCount + asset.curatedExposureCount,
      curatedFallbackExposureCount: total.curatedFallbackExposureCount + asset.curatedFallbackExposureCount,
      structuredExposureCount: total.structuredExposureCount + asset.structuredExposureCount,
      unstructuredExposureCount: total.unstructuredExposureCount + asset.unstructuredExposureCount,
      totalExposureWeight: total.totalExposureWeight + asset.totalExposureWeight,
      sourceNativeExposureWeight: total.sourceNativeExposureWeight + asset.sourceNativeExposureWeight,
      structuredExposureWeight: total.structuredExposureWeight + asset.structuredExposureWeight,
    }),
    {
      exposureCount: 0,
      sourceNativeExposureCount: 0,
      curatedExposureCount: 0,
      curatedFallbackExposureCount: 0,
      structuredExposureCount: 0,
      unstructuredExposureCount: 0,
      totalExposureWeight: 0,
      sourceNativeExposureWeight: 0,
      structuredExposureWeight: 0,
    },
  );

  const lanes = (["dex", "redemption"] as const).map((lane) => {
    const matching = routeAssets.filter((entry) => entry.lane === lane);
    const contributingAssetIds = sortedUnique(
      matching.filter((entry) => entry.v9ContributingRouteKeys.length > 0).map((entry) => entry.assetId),
    );
    const minimumContributingAssets =
      lane === "dex"
        ? V9_RELEASE_COVERAGE_FLOORS.minimumDexContributingAssets
        : V9_RELEASE_COVERAGE_FLOORS.minimumRedemptionContributingAssets;
    return {
      lane,
      routeCount: matching.reduce((sum, entry) => sum + entry.routeKeys.length, 0),
      scoreEligibleRouteCount: matching.reduce((sum, entry) => sum + entry.scoreEligibleRouteKeys.length, 0),
      exactCoverageRouteCount: matching.reduce((sum, entry) => sum + entry.exactCoverageRouteKeys.length, 0),
      currentRouteCount: matching.reduce((sum, entry) => sum + entry.currentRouteKeys.length, 0),
      capabilityCompleteRouteCount: matching.reduce((sum, entry) => sum + entry.capabilityCompleteRouteKeys.length, 0),
      outputResolvedRouteCount: matching.reduce((sum, entry) => sum + entry.outputResolvedRouteKeys.length, 0),
      valuationCurrentRouteCount: matching.reduce((sum, entry) => sum + entry.valuationCurrentRouteKeys.length, 0),
      v9ContributingRouteCount: matching.reduce((sum, entry) => sum + entry.v9ContributingRouteKeys.length, 0),
      v9ContributingAssetIds: contributingAssetIds,
      minimumContributingAssets,
      floorPassed: contributingAssetIds.length >= minimumContributingAssets,
    };
  });
  const dexLane = lanes[0]!;
  const redemptionLane = lanes[1]!;
  addBlocker(
    !dexLane.floorPassed,
    "dex-v9-contributing-assets-below-45",
    `DEX v9-contributing asset count ${dexLane.v9ContributingAssetIds.length} is below 45.`,
  );
  addBlocker(
    !redemptionLane.floorPassed,
    "redemption-v9-contributing-assets-below-27",
    `Redemption v9-contributing asset count ${redemptionLane.v9ContributingAssetIds.length} is below 27.`,
  );

  const reviews = REVIEW_DOMAINS.map((domain) => {
    const states = factSet.assets.map((asset) => ({ assetId: asset.assetId, ...reviewState(asset, domain) }));
    const applicabilityReviewedCount = states.filter((state) => state.applicabilityReviewed).length;
    const currentCompleteCount = states.filter((state) => state.currentComplete).length;
    return {
      domain,
      activeCount: states.length,
      applicabilityReviewedCount,
      currentCompleteCount,
      currentCompleteBps: states.length === 0 ? 0 : Math.floor((currentCompleteCount * 10_000) / states.length),
      incompleteAssetIds: sortedUnique(states.filter((state) => !state.currentComplete).map((state) => state.assetId)),
      unresolvedApplicabilityAssetIds: sortedUnique(
        states.filter((state) => !state.applicabilityReviewed).map((state) => state.assetId),
      ),
    };
  });

  const archetypeValues = sortedUnique(
    factSet.assets.flatMap((asset) => (asset.archetype === "unresolved" ? [] : [asset.archetype])),
  ) as MechanismArchetype[];
  const archetypes = archetypeValues.map((archetype) => {
    const assetIds = factSet.assets.filter((asset) => asset.archetype === archetype).map((asset) => asset.assetId);
    const rated = assetIds.filter((assetId) => rateableSet.has(assetId));
    const requiredRateable = Math.min(V9_RELEASE_COVERAGE_FLOORS.minimumArchetypeRateableAssets, assetIds.length);
    let boundedWeightUsd = 0;
    let ratedWeightUsd = 0;
    const unbounded: string[] = [];
    for (const assetId of assetIds) {
      const cohort = manifestById.get(assetId);
      if (!cohort) {
        unbounded.push(assetId);
        continue;
      }
      const weight = cohort.weight;
      if (weight.disposition === "current-valid") {
        boundedWeightUsd += weight.canonicalUsd!;
        if (rateableSet.has(assetId) && !weightMismatchIds.includes(assetId)) ratedWeightUsd += weight.canonicalUsd!;
      } else if (weight.conservativeUpperBoundUsd === null) {
        unbounded.push(assetId);
      } else {
        boundedWeightUsd += weight.conservativeUpperBoundUsd;
      }
    }
    const allRateable = rated.length === assetIds.length;
    const countFloorPassed = rated.length >= requiredRateable;
    const weightFloorPassed =
      unbounded.length === 0 &&
      assetIds.every((assetId) => !weightMismatchIds.includes(assetId)) &&
      meetsRatio(
        ratedWeightUsd,
        boundedWeightUsd,
        V9_RELEASE_COVERAGE_FLOORS.minimumArchetypeRateableWeightBps,
        allRateable,
      );
    addBlocker(
      !countFloorPassed,
      "archetype-rateable-count-below-floor",
      `${archetype} has ${rated.length} rateable assets; ${requiredRateable} are required.`,
      null,
      archetype,
    );
    addBlocker(
      !weightFloorPassed,
      "archetype-weight-rateability-below-80-percent",
      `${archetype} does not prove 80% bounded canonical-weight rateability.`,
      null,
      archetype,
    );
    return {
      archetype,
      activeCount: assetIds.length,
      rateableCount: rated.length,
      requiredRateableCount: requiredRateable,
      countFloorPassed,
      boundedWeightUsd,
      rateableWeightUsd: ratedWeightUsd,
      unboundedWeightAssetIds: sortedUnique(unbounded),
      rateableWeightBps: ratioBps(ratedWeightUsd, boundedWeightUsd, allRateable && unbounded.length === 0),
      weightFloorPassed,
      passed: countFloorPassed && weightFloorPassed,
    };
  });

  const orderedBlockers = blockers.sort((left, right) => compareText(blockerSortKey(left), blockerSortKey(right)));
  const reportWithoutDigest = {
    schemaVersion: 1 as const,
    releaseCandidateId: manifest.releaseCandidateId,
    cohortId: manifest.cohortId,
    decision: orderedBlockers.length === 0 ? ("gate-passed" as const) : ("no-go" as const),
    identities: {
      factSetDigest: factSet.v9FactSetDigest,
      baseInputGenerationId: factSet.baseInputGenerationId,
      policyId: evaluation.policyId,
      policyDigest: evaluation.policyDigest,
      evaluationBuildDigest: evaluation.evaluationBuildDigest,
      producerCapabilityDigest: evaluation.producerCapabilityDigest,
      evaluatedSetDigest: evaluation.evaluatedSetDigest,
      scoreResultDigest: evaluation.scoreResultDigest,
      evaluationProjectionDigest: computedEvaluationProjectionDigest,
      asOfSec: factSet.asOfSec,
      sourceFingerprints: factSet.sourceFingerprints,
    },
    identityChecks,
    floors: V9_RELEASE_COVERAGE_FLOORS,
    activeSet,
    rateability: {
      activeCount: factIds.length,
      rateableCount: rateableIds.length,
      notRatedCount: factIds.length - rateableIds.length,
      requiredRateableCount,
      passed: rateabilityPassed,
    },
    weights: {
      currentValidAssetIds: sortedUnique(currentValidAssetIds),
      missingAssetIds: sortedUnique(missingAssetIds),
      invalidAssetIds: sortedUnique(invalidAssetIds),
      unboundedAssetIds: sortedUnique(unboundedAssetIds),
      boundedCanonicalWeightUsd,
      rateableCanonicalWeightUsd,
      rateableWeightBps,
      passed: weightPassed,
    },
    topCutoff: {
      position: V9_RELEASE_COVERAGE_FLOORS.topCutoffPosition,
      cutoffUsd,
      determinate: topCutoffDeterminate,
      derivedMemberIds: derivedTopIds,
      manifestMemberIds: manifestTopIds,
      currentValidMemberIds: sortedUnique(topCurrentValid),
      rateableMemberIds: sortedUnique(topRateable),
      evidenceCompleteMemberIds: sortedUnique(topEvidenceCompleteIds),
      ranksConsistent,
      membershipConsistent,
      passed: topPassed,
    },
    calibration: {
      memberIds: calibrationMemberIds,
      requiredRateableIds: calibrationRequiredIds,
      intentionalEvidenceGapIds,
      ratedRequiredIds: sortedUnique(ratedRequiredIds),
      passed: calibrationSizePassed && calibrationCompositionPassed && calibrationRateabilityPassed,
    },
    nrReviews: {
      notRatedAssetIds: sortedUnique(notRatedAssetIds),
      reviewedAssetIds: sortedUnique(reviewedNrIds),
      missingReviewAssetIds: sortedUnique(missingNrReviewIds),
      reasonMismatchAssetIds: sortedUnique(reasonMismatchIds),
      passed: nrReviewPassed,
    },
    reserves: { ...reserveTotals, assets: reserveAssets },
    exit: {
      lanes: [dexLane, redemptionLane] as const,
      assets: routeAssets.map(({ exactCoverageRouteKeys: _exactCoverageRouteKeys, ...entry }) => entry),
      passed: dexLane.floorPassed && redemptionLane.floorPassed,
    },
    reviews: reviews as [
      (typeof reviews)[number],
      (typeof reviews)[number],
      (typeof reviews)[number],
      (typeof reviews)[number],
      (typeof reviews)[number],
      (typeof reviews)[number],
    ],
    archetypes,
    producerCapabilityDigest: evaluation.producerCapabilityDigest,
    blockers: orderedBlockers,
  };
  const reportDigest = sha256Hex(
    stableJsonStringifyV1({ domain: V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN, report: reportWithoutDigest }),
  );
  return deepFreeze(V9ReleaseCoverageReportV1Schema.parse({ ...reportWithoutDigest, reportDigest }));
}
