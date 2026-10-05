import {
  resolveV9ExitCapacityAtRequest,
  selectV9ExitCirculatingUsd,
  selectV9ExitStressRequest,
} from "@shared/lib/safety-score-v9/exit";
import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type {
  V9AssetFactsV2,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9EffectiveDependenciesV3,
  V9ExitRouteFactV2,
  V9FactStatusV2,
  V9ReserveExposureFactV2,
} from "@shared/types/safety-score-v9-facts";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperLocalDimensionFact,
  type V9WrapperLocalFacts,
  type V9WrapperRiskAssessment,
} from "@shared/types/safety-score-v9-wrapper";
import {
  addEvidence,
  componentResearchEvidence,
  fallbackResearchEvidence,
  missingLocalFact,
  type AssetBuildContext,
} from "./fact-set-context";
import type { V9AllocationScopeFact, V9AllocationScoredDimension } from "@shared/types/safety-score-v9-allocation";
import { resolveAllocationDimensionCoverage } from "./fact-set-allocation";
import { allocationReviewClockSec } from "@shared/types/safety-score-v9-allocation";
import type { SafetyScoreV9WrapperLocalReview } from "@shared/types/safety-score-v9-wrapper-local-review";

interface WrapperLocalFactBuildInputs {
  implementation: V9AssetFactsV2["implementation"];
  dependencies: V9EffectiveDependenciesV3;
  reserveStatus: V9FactStatusV2;
  reserveExposures: readonly V9ReserveExposureFactV2[];
  exitStatus: V9FactStatusV2;
  exitRoutes: readonly V9ExitRouteFactV2[];
  controlStatus: V9FactStatusV2;
  controls: readonly V9DeploymentControlFactV2[];
  economicControlReview: V9EconomicControlReviewV2;
  peg: V9AssetFactsV2["peg"];
  supply: V9AssetFactsV2["supply"];
  allocationScopeFacts?: readonly V9AllocationScopeFact[];
}

export function resolveWrapperForm(
  asset: AssetBuildContext["asset"],
  dependencies?: V9EffectiveDependenciesV3,
): V9ApplicableWrapperLocalFacts["form"] | null {
  if (asset.variantKind === "pure-wrapper") return "pure";
  if (asset.variantKind === "savings-passthrough") return "native-staked";
  if (asset.variantKind === "risk-absorption") {
    return asset.wrapperOperator === "third-party" ? "strategy-vault" : "native-staked";
  }
  if (
    asset.variantKind === "strategy-vault" ||
    dependencies?.edges.some(
      (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
    )
  ) {
    return "strategy-vault";
  }
  return null;
}

function uniqueEvidenceRefIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function wrapperFactDisposition(
  context: AssetBuildContext,
  statuses: readonly V9FactStatusV2[],
  _fallback: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> = "unresearched",
): Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> {
  const responsibilities = statuses.flatMap((status) =>
    status.gapIds.flatMap((gapId) => {
      const responsibility = context.gaps.get(gapId)?.responsibility;
      return responsibility ? [responsibility] : [];
    }),
  );
  if (responsibilities.includes("issuer-undisclosed")) return "issuer-undisclosed";
  if (responsibilities.includes("unresearched")) return "unresearched";
  if (responsibilities.includes("method-unsupported")) return "method-unsupported";
  if (responsibilities.includes("producer-failed")) return "producer-failed";
  if (responsibilities.includes("integration-missing")) return "integration-missing";
  if (responsibilities.includes("public-data-uncurated")) return "public-data-uncurated";
  return "unresearched";
}

function reviewedWrapperFact(
  context: AssetBuildContext,
  assessment: V9WrapperRiskAssessment,
  signals: readonly string[],
  evidenceRefIds: readonly string[],
): V9WrapperLocalDimensionFact {
  const evidence = uniqueEvidenceRefIds(evidenceRefIds);
  return {
    disposition: "reviewed",
    assessment,
    signals: [...signals],
    evidenceRefIds: evidence.length > 0 ? evidence : [fallbackResearchEvidence(context)],
  };
}

function unavailableWrapperFact(
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">,
  signal: string,
  evidenceRefIds: readonly string[] = [],
): V9WrapperLocalDimensionFact {
  return {
    disposition,
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function notApplicableWrapperFact(signal: string, evidenceRefIds: readonly string[] = []): V9WrapperLocalDimensionFact {
  return {
    disposition: "not-applicable",
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function isDirectSerialWrapper(
  context: AssetBuildContext,
  form: V9ApplicableWrapperLocalFacts["form"],
  wrapperEdge: V9EffectiveDependenciesV3["edges"][number] | undefined,
): boolean {
  // No tracked serial parent edge means we cannot prove the wrapper is a direct
  // pass-through, so it is NOT treated as one and keeps the conservative
  // `issuer-undisclosed` dispositions. This is the fail-closed path and it is
  // deliberately not an assertion: a missing edge is a registry-completeness
  // condition, and throwing here would abort the whole asset's compilation and
  // take unrelated facts down with it — a wM fixture with no wrapper edge lost
  // its entire supply observation and reported `missing-pillar-evidence` instead
  // of its real bridge-route gap.
  if (wrapperEdge === undefined) return false;
  return (
    (form === "pure" && context.asset.variantKind === "pure-wrapper") ||
    (form === "native-staked" && context.asset.variantKind === "savings-passthrough")
  );
}

function resolveWrapperFactFromScope(
  existing: V9WrapperLocalDimensionFact,
  facts: readonly V9AllocationScopeFact[],
  dimension: V9AllocationScoredDimension,
): V9WrapperLocalDimensionFact {
  const scope = resolveAllocationDimensionCoverage(facts, dimension);
  if (scope.signals.length === 0) return existing;
  const evidenceRefIds = uniqueEvidenceRefIds([...existing.evidenceRefIds, ...scope.evidenceRefIds]);
  const signals = [...existing.signals, ...scope.signals];
  // Partial favorable evidence is diagnostic, never a whole-book verdict.
  // Existing reviewed adverse facts are not replaced by a better local scope.
  if (scope.assessment !== null && existing.disposition === "reviewed" && existing.assessment !== null) {
    return { ...existing, assessment: worstWrapperRisk([existing.assessment, scope.assessment]), signals, evidenceRefIds };
  }
  if (scope.complete && scope.assessment !== null && scope.assessment !== "none" && existing.disposition === "not-applicable") {
    // Complete positive adverse evidence supersedes a structural absence
    // assumption; a savings/pure label cannot hide proved local borrowing.
    return { disposition: "reviewed", assessment: scope.assessment,
      signals: [...scope.signals, "allocation-scope-overrides-structural-absence"], evidenceRefIds };
  }
  if (scope.complete && scope.assessment !== null && allocationCanResolveWrapperFact(existing)) {
    return { disposition: "reviewed", assessment: scope.assessment,
      signals: [...scope.signals, `allocation-scope-complete:${dimension}`], evidenceRefIds };
  }
  return { ...existing, signals, evidenceRefIds };
}

function allocationCanResolveWrapperFact(fact: V9WrapperLocalDimensionFact): boolean {
  // Positive allocation evidence may resolve any unavailable fact, regardless
  // of its missing-cause label, but must not replace reviewed risk or absence.
  return fact.disposition !== "reviewed" && fact.disposition !== "not-applicable";
}

function resolveWrapperFactFromAllocation(
  existing: V9WrapperLocalDimensionFact,
  resolution: V9WrapperLocalDimensionFact,
): V9WrapperLocalDimensionFact {
  return allocationCanResolveWrapperFact(existing)
    ? {
        ...resolution,
        evidenceRefIds: uniqueEvidenceRefIds([
          ...existing.evidenceRefIds,
          ...resolution.evidenceRefIds,
        ]),
      }
    : existing;
}

function assertDirectSerialWrapperFactDispositionInvariant(
  context: AssetBuildContext,
  directSerialWrapper: boolean,
  facts: Pick<
    V9ApplicableWrapperLocalFacts["facts"],
    "custodyEscrow" | "leverage" | "rehypothecationCorrelation"
  >,
): void {
  if (!directSerialWrapper || context.asset.wrapperCustodyReview != null) return;
  const issuerUndisclosedFacts = (
    [
      ["custodyEscrow", facts.custodyEscrow],
      ["leverage", facts.leverage],
      ["rehypothecationCorrelation", facts.rehypothecationCorrelation],
    ] as const
  )
    .filter(([, fact]) => fact.disposition === "issuer-undisclosed")
    .map(([factKey]) => factKey);
  if (issuerUndisclosedFacts.length > 0) {
    throw new Error(
      `Safety Score v9 wrapper invariant violated for ${context.asset.assetId}: ` +
        `profileless direct serial wrapper emitted issuer-undisclosed for ${issuerUndisclosedFacts.join(",")}`,
    );
  }
}

function wrapperControlRisk(
  control: V9DeploymentControlFactV2,
): { assessment: V9WrapperRiskAssessment; signals: string[] } {
  if (control.incidentState === "active") {
    return { assessment: "critical", signals: [`active-control-incident:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "unbounded" ||
    control.economicLossScope === "global-claim" ||
    control.capSemantics.kind === "unbounded"
  ) {
    return { assessment: "high", signals: [`unbounded-claim-control:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "bounded" ||
    control.economicLossScope === "reserve-claim" ||
    control.capSemantics.kind === "raiseable"
  ) {
    return { assessment: "moderate", signals: [`claim-affecting-control:${control.controlKey}`] };
  }
  return { assessment: "low", signals: [`non-claim-control:${control.controlKey}`] };
}

function worstWrapperRisk(values: readonly V9WrapperRiskAssessment[]): V9WrapperRiskAssessment {
  const rank: Readonly<Record<V9WrapperRiskAssessment, number>> = {
    none: 0,
    low: 1,
    moderate: 2,
    high: 3,
    critical: 4,
  };
  return [...values].sort((left, right) => rank[right] - rank[left])[0] ?? "none";
}

function isReviewableLocalControlStatus(status: V9FactStatusV2): boolean {
  return status.observationState === "known" || status.observationState === "bounded-unknown";
}

interface WrapperLocalBuildState {
  form: V9ApplicableWrapperLocalFacts["form"];
  wrapperEdge: V9EffectiveDependenciesV3["edges"][number] | undefined;
  reviewedFormEvidence: string[];
  controlEvidenceRefIds: string[];
  reserveEvidenceRefIds: string[];
  allocationEvidenceRefIds: string[];
  routeEvidenceRefIds: string[];
}

function independentlyReviewedImmutableRootEvidence(context: AssetBuildContext): string[] | null {
  const review = context.asset.allocationScopeIdentityReview;
  if (!review || review.assetId !== context.asset.assetId || review.registeredDeploymentKeys.length === 0) return null;
  const registered = new Set(review.registeredDeploymentKeys);
  if (registered.size !== review.registeredDeploymentKeys.length || review.deployments.length !== registered.size) return null;
  const clock = context.fixedInput.clockSec;
  const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
  const observed = new Set<string>();
  for (const deployment of review.deployments) {
    const key = `${deployment.chain}:${deployment.address}`;
    if (deployment.codeKind !== "immutable" || !registered.has(key) || observed.has(key) || !deployment.sourceUrl ||
      deployment.observedAtSec > clock || clock - deployment.observedAtSec > maxAgeSec) return null;
    observed.add(key);
  }
  // Bind evidence to this identity packet's own observation and generation,
  // never the aggregate mint review's freshness or a whole-allocation claim.
  const sourceGenerationId = context.extension.sources.researchOverlays.generationId;
  return review.deployments.map((deployment) => addEvidence(context, createV9EvidenceReference({
    evidenceId: `${context.asset.assetId}:wrapper-immutable-root:${deployment.chain}:${deployment.address}`,
    sourceId: "safety-score-v9.wrapper-immutable-root-identity", sourceGenerationId,
    disposition: "observed", observedAtSec: deployment.observedAtSec, url: deployment.sourceUrl,
    contentSha256: domainDigest("safety-score-v9.wrapper-immutable-root-identity.v1", deployment),
    maxAgeSec,
  }, clock)));
}

function independentWrapperLocalReview(
  context: AssetBuildContext,
  kind: SafetyScoreV9WrapperLocalReview["kind"],
): { review: SafetyScoreV9WrapperLocalReview; evidenceRefIds: string[] } | null {
  const matches = (context.asset.wrapperLocalReviews ?? []).filter((review) => review.kind === kind);
  if (matches.length !== 1) return null;
  const review = matches[0]!;
  const identity = context.asset.allocationScopeIdentityReview;
  const clock = context.fixedInput.clockSec;
  const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
  if (!identity || review.assetId !== context.asset.assetId || review.identity.assetId !== review.assetId ||
    identity.assetId !== review.assetId || allocationReviewClockSec(review.reviewedAt) > clock ||
    review.observedAtSec > clock || clock >= review.expiresAtSec || clock - review.observedAtSec > maxAgeSec) return null;
  const registered = new Set(identity.registeredDeploymentKeys);
  if (registered.size === 0 || registered.size !== identity.registeredDeploymentKeys.length ||
    registered.size !== review.identity.registeredDeploymentKeys.length ||
    review.identity.registeredDeploymentKeys.some((key) => !registered.has(key)) ||
    new Set(review.identity.registeredDeploymentKeys).size !== registered.size ||
    review.identity.deployments.length !== registered.size) return null;
  const seen = new Set<string>();
  for (const deployment of review.identity.deployments) {
    const key = `${deployment.chain}:${deployment.address}`;
    const retained = identity.deployments.filter((row) => row.chain === deployment.chain && row.address === deployment.address);
    if (!registered.has(key) || seen.has(key) || retained.length !== 1 ||
      deployment.observedAtSec > review.observedAtSec || clock - deployment.observedAtSec > maxAgeSec ||
      retained[0]!.codeKind !== deployment.codeKind || !review.sources.some((source) => source.url === deployment.sourceUrl)) return null;
    if (deployment.codeKind === "proxy") {
      const current = retained[0]!;
      if (current.codeKind !== "proxy" || current.implementation !== deployment.implementation ||
        current.observedAtSec > clock || clock - current.observedAtSec > maxAgeSec) return null;
    }
    seen.add(key);
  }
  const evidenceRefIds = review.sources.map((source) => addEvidence(context, createV9EvidenceReference({
    evidenceId: `${review.assetId}:wrapper-local-review:${kind}:${domainDigest("safety-score-v9.wrapper-local-source.v1", source).slice(0, 16)}`,
    sourceId: "safety-score-v9.wrapper-local-review",
    sourceGenerationId: context.extension.sources.researchOverlays.generationId,
    disposition: "observed", observedAtSec: review.observedAtSec, url: source.url,
    contentSha256: domainDigest("safety-score-v9.wrapper-local-review.v1", { review, source }),
    maxAgeSec: Math.min(maxAgeSec, review.expiresAtSec - review.observedAtSec),
  }, clock)));
  return { review, evidenceRefIds };
}

function buildWrapperStructuralDimensions(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): {
  contractMutability: V9WrapperLocalDimensionFact;
  custodyEscrow: V9WrapperLocalDimensionFact;
  strategyComplexity: V9WrapperLocalDimensionFact;
  leverage: V9WrapperLocalDimensionFact;
  rehypothecationCorrelation: V9WrapperLocalDimensionFact;
  shareAccountingNavOracle: V9WrapperLocalDimensionFact;
} {
  const {
    form,
    wrapperEdge,
    reviewedFormEvidence,
    controlEvidenceRefIds,
    reserveEvidenceRefIds,
    allocationEvidenceRefIds,
  } = state;
  const directSerialWrapper = isDirectSerialWrapper(context, form, wrapperEdge);
  const authoredAllocation = context.asset.wrapperAllocationReview ?? null;
  // Reuse the A3 date/custody gate at the compiler boundary as well as intake:
  // retained extensions cannot turn expired or future allocation proof into relief.
  const allocation =
    authoredAllocation !== null &&
    authoredAllocation.scopeKind === "whole-allocation" &&
    Date.parse(`${authoredAllocation.reviewedAt}T00:00:00.000Z`) <= context.fixedInput.clockSec * 1_000 &&
    context.fixedInput.clockSec * 1_000 < Date.parse(`${authoredAllocation.expiresAt}T00:00:00.000Z`) &&
    authoredAllocation.custody === "fully-onchain-no-offchain-custodian"
      ? authoredAllocation
      : null;
  let contractMutability: V9WrapperLocalDimensionFact;
  const upgrade = input.economicControlReview.mint.upgrade;
  // This independent lane establishes only root-code mutability. Mutable
  // roles, modules, fees and allocations remain in their existing dimensions.
  const immutableRootEvidence =
    input.economicControlReview.mint.status.observationState !== "known" && upgrade.state === "immutable"
      ? independentlyReviewedImmutableRootEvidence(context)
      : null;
  if (immutableRootEvidence !== null) {
    contractMutability = reviewedWrapperFact(
      context,
      "none",
      ["wrapper-upgrade-state:immutable", "wrapper-immutable-root-identity:exhaustive"],
      immutableRootEvidence,
    );
  } else if (input.economicControlReview.mint.status.observationState !== "known") {
    contractMutability = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.economicControlReview.mint.status]),
      "wrapper-upgrade-review-unavailable",
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "immutable" || upgrade.state === "not-applicable") {
    contractMutability = reviewedWrapperFact(
      context,
      "none",
      [`wrapper-upgrade-state:${upgrade.state}`],
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "reviewed" && upgrade.controlKey !== null) {
    const upgradeControl = input.controls.find((control) => control.controlKey === upgrade.controlKey);
    if (!upgradeControl || upgradeControl.status.observationState !== "known") {
      contractMutability = unavailableWrapperFact(
        "integration-missing",
        `reviewed-upgrade-control-not-compiled:${upgrade.controlKey}`,
        controlEvidenceRefIds,
      );
    } else {
      const delayAssessment: V9WrapperRiskAssessment =
        upgradeControl.delaySec === null || upgradeControl.delaySec < 86_400
          ? "high"
          : upgradeControl.delaySec < 604_800
            ? "moderate"
            : "low";
      const authorityRisk = wrapperControlRisk(upgradeControl);
      contractMutability = reviewedWrapperFact(
        context,
        worstWrapperRisk([delayAssessment, authorityRisk.assessment]),
        [
          `wrapper-upgrade-authority:${upgradeControl.authority?.model ?? "unknown"}`,
          `wrapper-upgrade-delay-sec:${upgradeControl.delaySec ?? "undisclosed"}`,
          ...authorityRisk.signals,
        ],
        controlEvidenceRefIds,
      );
    }
  } else {
    contractMutability = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-upgrade-authority-undisclosed",
      controlEvidenceRefIds,
    );
  }

  let custodyEscrow: V9WrapperLocalDimensionFact;
  const custody = context.asset.wrapperCustodyReview ?? null;
  const hasUnknownCustody =
    custody === null ||
    custody.segregation === "unknown" ||
    custody.bankruptcyRemoteness === "unknown" ||
    custody.knownUnknownExposureShare === null ||
    custody.knownUnknownExposureShare > 0;
  // The on-chain enum scopes a direct claim only when corroborated by current
  // allocation proof or the custody review's own complete exposure checks.
  const directOnchainCustody =
    directSerialWrapper &&
    custody?.custodyModel === "onchain" &&
    (allocation !== null || !hasUnknownCustody);
  if (custody !== null && !directOnchainCustody) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:custodyEscrow");
    custodyEscrow = hasUnknownCustody
      ? unavailableWrapperFact(
          "issuer-undisclosed",
          `wrapper-custody-terms-incomplete:${custody.knownUnknownExposureShare ?? "unknown"}`,
          custodyEvidence,
        )
      : reviewedWrapperFact(
          context,
          custody.segregation === "segregated" && custody.bankruptcyRemoteness === "structured"
            ? "low"
            : custody.bankruptcyRemoteness === "none"
              ? "high"
              : "moderate",
          [
            `wrapper-custody-providers:${custody.providers.length}`,
            `wrapper-custody-segregation:${custody.segregation}`,
            `wrapper-custody-bankruptcy-remoteness:${custody.bankruptcyRemoteness}`,
          ],
          custodyEvidence,
        );
  } else if (directSerialWrapper) {
    custodyEscrow = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-custody-is-the-serial-parent-contract-claim"
        : "savings-passthrough-has-no-local-custody-or-escrow",
      uniqueEvidenceRefIds([
        ...reviewedFormEvidence,
        ...allocationEvidenceRefIds,
        ...(directOnchainCustody ? componentResearchEvidence(context, "wrapper-local:custodyEscrow") : []),
      ]),
    );
  } else {
    custodyEscrow = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-custody-or-escrow-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    custodyEscrow = resolveWrapperFactFromAllocation(
      custodyEscrow,
      notApplicableWrapperFact(
        "reviewed-allocation-is-fully-onchain-with-no-offchain-custodian",
        allocationEvidenceRefIds,
      ),
    );
  }

  let strategyComplexity: V9WrapperLocalDimensionFact;
  if (form === "pure" && wrapperEdge !== undefined) {
    strategyComplexity = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-has-no-local-strategy"],
      reviewedFormEvidence,
    );
  } else if (form === "native-staked") {
    const riskAbsorption = context.asset.variantKind === "risk-absorption";
    strategyComplexity = reviewedWrapperFact(
      context,
      riskAbsorption ? "moderate" : "low",
      [
        riskAbsorption
          ? "native-wrapper-adds-reviewed-loss-absorption-layer"
          : "native-wrapper-is-single-parent-savings-passthrough",
      ],
      reviewedFormEvidence,
    );
  } else if (form === "strategy-vault") {
    // A current, no-reuse allocation over one fully tracked serial claim scopes
    // custody uncertainty to the parent. Mixed books and stale reviews do not.
    const directParentAllocation =
      allocation !== null &&
      allocation.localLeverage === "no-borrowing-surface" &&
      allocation.capitalReuse === "none" &&
      wrapperEdge !== undefined &&
      wrapperEdge.weight === 1 &&
      input.dependencies.diagnostics.graphState === "valid" &&
      input.dependencies.edges.length === 1 &&
      input.reserveStatus.observationState === "known" &&
      input.reserveExposures.length > 0 &&
      input.reserveExposures.every((exposure) =>
        exposure.status.observationState === "known" &&
        exposure.trackedAssetId === wrapperEdge.upstreamAssetId,
      );
    const highComplexity =
      input.reserveExposures.some((exposure) => exposure.assetClass === "private-credit") ||
      (!directParentAllocation && custody?.knownUnknownExposureShare != null &&
        custody.knownUnknownExposureShare > 0);
    strategyComplexity = reviewedWrapperFact(
      context,
      highComplexity ? "high" : "moderate",
      [
        highComplexity
          ? "strategy-vault-has-private-or-unknown-credit-exposure"
          : "strategy-vault-adds-third-party-allocation-layer",
        `wrapper-strategy-reserve-components:${input.reserveExposures.length}`,
      ],
      uniqueEvidenceRefIds([
        ...reviewedFormEvidence,
        ...reserveEvidenceRefIds,
        ...(directParentAllocation ? allocationEvidenceRefIds : []),
      ]),
    );
  } else {
    strategyComplexity = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus]),
      "wrapper-strategy-complexity-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let leverage: V9WrapperLocalDimensionFact;
  if (directSerialWrapper) {
    leverage = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-has-no-local-strategy-leverage"
        : "savings-passthrough-has-no-local-borrowing-surface",
      reviewedFormEvidence,
    );
  } else if (input.reserveStatus.observationState === "known") {
    const hasLeverage = input.reserveExposures.some((exposure) =>
      exposure.riskFactors.includes("leverage"),
    );
    leverage = hasLeverage
      ? reviewedWrapperFact(
          context,
          "high",
          ["wrapper-leverage-factor:leverage"],
          reserveEvidenceRefIds,
        )
      : unavailableWrapperFact(
          "issuer-undisclosed",
          "wrapper-leverage-review-does-not-establish-absence",
          reserveEvidenceRefIds,
        );
  } else {
    leverage = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-leverage-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    leverage = resolveWrapperFactFromAllocation(
      leverage,
      reviewedWrapperFact(
        context,
        V9_CANDIDATE_POLICY_V1.policy.semantic.formula.wrapperAllocationScope.leverageAssessments[allocation.localLeverage],
        [
          `wrapper-allocation-local-leverage:${allocation.localLeverage}`,
          `wrapper-allocation-observation-count:${allocation.observations.length}`,
        ],
        allocationEvidenceRefIds,
      ),
    );
  }

  let rehypothecationCorrelation: V9WrapperLocalDimensionFact;
  if (custody !== null && !directOnchainCustody) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:rehypothecationCorrelation");
    rehypothecationCorrelation =
      custody.rehypothecation === "unknown"
        ? unavailableWrapperFact(
            "issuer-undisclosed",
            "wrapper-rehypothecation-terms-undisclosed",
            custodyEvidence,
          )
        : reviewedWrapperFact(
            context,
            custody.rehypothecation === "prohibited"
              ? "low"
              : custody.rehypothecation === "conditional"
                ? "moderate"
                : "high",
            [
              `wrapper-rehypothecation:${custody.rehypothecation}`,
              `wrapper-custody-provider-count:${custody.providers.length}`,
            ],
            custodyEvidence,
          );
  } else if (directSerialWrapper) {
    rehypothecationCorrelation = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-parent-correlation-is-applied-by-serial-dependency"
        : "savings-passthrough-holds-one-parent-and-reuses-nothing",
      uniqueEvidenceRefIds([
        ...reviewedFormEvidence,
        ...allocationEvidenceRefIds,
        ...(directOnchainCustody
          ? componentResearchEvidence(context, "wrapper-local:rehypothecationCorrelation")
          : []),
      ]),
    );
  } else {
    rehypothecationCorrelation = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-rehypothecation-correlation-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    rehypothecationCorrelation = resolveWrapperFactFromAllocation(
      rehypothecationCorrelation,
      reviewedWrapperFact(
        context,
        V9_CANDIDATE_POLICY_V1.policy.semantic.formula.wrapperAllocationScope.reuseAssessments[allocation.capitalReuse],
        [
          `wrapper-allocation-capital-reuse:${allocation.capitalReuse}`,
          `wrapper-allocation-observation-count:${allocation.observations.length}`,
        ],
        allocationEvidenceRefIds,
      ),
    );
  }

  let shareAccountingNavOracle: V9WrapperLocalDimensionFact;
  const accountingReview = independentWrapperLocalReview(context, "accounting");
  if (accountingReview?.review.kind === "accounting") {
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      accountingReview.review.mechanism === "fixed-face-accounting" ? "none" : "moderate",
      [`wrapper-local-accounting:${accountingReview.review.mechanism}`, "borrower-liquidation-oracle-risk-retained-separately"],
      accountingReview.evidenceRefIds,
    );
  } else if (form === "pure") {
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-fixed-parent-claim-accounting"],
      reviewedFormEvidence,
    );
  } else if (
    (context.asset.variantKind === "savings-passthrough" ||
      context.asset.variantKind === "risk-absorption" ||
      context.asset.variantKind === "strategy-vault") &&
    input.peg.referenceKind === "nav" &&
    input.peg.status.observationState === "known"
  ) {
    const oracleTier = input.economicControlReview.oracle.tier;
    const weakOracle =
      oracleTier === "privileged-internal-pricing" ||
      oracleTier === "single-source-or-laggy";
    shareAccountingNavOracle = oracleTier === "opaque-or-unknown"
      ? unavailableWrapperFact(
          "issuer-undisclosed",
          "wrapper-share-oracle-topology-undisclosed",
          input.economicControlReview.oracle.status.evidenceRefIds,
        )
      : reviewedWrapperFact(
          context,
          weakOracle ? "high" : "moderate",
          [
            `wrapper-share-form:${context.asset.variantKind}`,
            `wrapper-share-reference-kind:${input.peg.referenceKind}`,
            `wrapper-share-oracle-tier:${oracleTier ?? "not-applicable"}`,
          ],
          uniqueEvidenceRefIds([
            ...reviewedFormEvidence,
            ...input.peg.status.evidenceRefIds,
            ...input.economicControlReview.oracle.status.evidenceRefIds,
          ]),
        );
  } else {
    shareAccountingNavOracle = unavailableWrapperFact(
      wrapperFactDisposition(
        context,
        [input.peg.status, input.economicControlReview.mint.status],
        "integration-missing",
      ),
      "wrapper-share-accounting-or-nav-oracle-review-unavailable",
      [...input.peg.status.evidenceRefIds, ...input.economicControlReview.mint.status.evidenceRefIds],
    );
  }
  custodyEscrow = resolveWrapperFactFromScope(custodyEscrow, input.allocationScopeFacts ?? [], "custodyEscrow");
  leverage = resolveWrapperFactFromScope(leverage, input.allocationScopeFacts ?? [], "leverage");
  rehypothecationCorrelation = resolveWrapperFactFromScope(rehypothecationCorrelation, input.allocationScopeFacts ?? [], "rehypothecationCorrelation");
  return {
    contractMutability,
    custodyEscrow,
    strategyComplexity,
    leverage,
    rehypothecationCorrelation,
    shareAccountingNavOracle,
  };
}

function buildWrapperExitDimensions(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): {
  withdrawalTerms: V9WrapperLocalDimensionFact;
  measuredUnwind: V9WrapperLocalDimensionFact;
} {
  const { routeEvidenceRefIds } = state;
  const knownRedemptionRoutes = input.exitRoutes.filter(
    (route) =>
      route.lane === "redemption" &&
      (route.status.observationState === "known" || route.status.observationState === "stale"),
  );
  let withdrawalTerms: V9WrapperLocalDimensionFact;
  const entitlementReview = independentWrapperLocalReview(context, "holder-entitlement");
  if (entitlementReview?.review.kind === "holder-entitlement") {
    withdrawalTerms = reviewedWrapperFact(
      context,
      "critical",
      [`wrapper-holder-entitlement:${entitlementReview.review.entitlement}`],
      entitlementReview.evidenceRefIds,
    );
  } else if (knownRedemptionRoutes.length === 0) {
    withdrawalTerms = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus]),
      "wrapper-withdrawal-fee-or-gate-terms-unavailable",
      routeEvidenceRefIds,
    );
  } else if (knownRedemptionRoutes.some((route) => route.feeEvidence === "undisclosed-reviewed")) {
    withdrawalTerms = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-withdrawal-fee-undisclosed",
      routeEvidenceRefIds,
    );
  } else {
    const termsRisk = knownRedemptionRoutes.map((route): V9WrapperRiskAssessment => {
      if (
        route.holderAccess === "issuer-only" ||
        route.executionModel === "discretionary" ||
        route.executionCertainty === "discretionary"
      ) {
        return "critical";
      }
      if (route.settlementModel === "queued" || route.executionModel === "queued") {
        return (route.settlementSlaSec ?? Number.POSITIVE_INFINITY) > 604_800 ? "high" : "moderate";
      }
      if (
        route.holderAccess === "allowlisted" ||
        route.holderAccess === "institutional-eligible" ||
        route.holderAccess === "verified-customer-neutral" ||
        route.executionCertainty === "conditional"
      ) {
        return "moderate";
      }
      return "low";
    });
    withdrawalTerms = reviewedWrapperFact(
      context,
      worstWrapperRisk(termsRisk),
      [
        ...knownRedemptionRoutes.flatMap((route) => [
          `wrapper-withdrawal-access:${route.holderAccess}`,
          `wrapper-withdrawal-execution:${route.executionModel}`,
          `wrapper-withdrawal-settlement:${route.settlementModel}:${route.settlementSlaSec ?? "atomic"}`,
        ]),
        // Fee quantification is a separate integration gap, never a reason to
        // erase observed access, execution, or queue restrictions.
        ...(knownRedemptionRoutes.some((route) => route.feeEvidence === "disclosed-unquantified")
          ? ["wrapper-withdrawal-formula-fee-not-quantified-at-policy-notional"]
          : []),
      ],
      routeEvidenceRefIds,
    );
  }

  const stressRequest = selectV9ExitStressRequest(
    selectV9ExitCirculatingUsd(input.supply),
    V9_CANDIDATE_POLICY_V1,
  );
  // A modeled route or partial inventory can establish a lower bound, not
  // observed exhaustion. Keep the same measurement gate as the Exit pillar.
  const observedUnwindRoutes = input.exitRoutes.filter(
    (route) =>
      route.status.observationState === "known" &&
      route.scoreEligible &&
      route.coverageClass === "exact-complete" &&
      route.evidenceKind !== "documented-terms" &&
      route.feeEvidence === undefined &&
      !route.settlementBoundUnproven &&
      route.capacityCurve.length > 0,
  );
  let measuredUnwind: V9WrapperLocalDimensionFact;
  const stressCompletions =
    stressRequest === null
      ? []
      : observedUnwindRoutes.flatMap((route) => {
          if (!route.capacityCurve.every((point): point is typeof point & { executionCostBps: number } =>
            point.executionCostBps !== null)) return [];
          const point = resolveV9ExitCapacityAtRequest(route.capacityCurve, stressRequest);
          return point === null ? [] : [point.completionRatio];
        });
  const bestCompletion = stressCompletions.length > 0 ? Math.max(...stressCompletions) : null;
  const unwindInventoryComplete = stressCompletions.length === input.exitRoutes.length;
  if (bestCompletion !== null && (bestCompletion >= 0.95 || unwindInventoryComplete)) {
    measuredUnwind = reviewedWrapperFact(
      context,
      bestCompletion >= 0.95
        ? "none"
        : bestCompletion >= 0.8
          ? "low"
          : bestCompletion >= 0.5
            ? "moderate"
            : bestCompletion > 0
              ? "high"
              : "critical",
      [
        `wrapper-measured-unwind-policy-notional:${stressRequest!.requestedNotionalUsd}`,
        `wrapper-measured-unwind-policy-completion:${bestCompletion}`,
        `wrapper-measured-unwind-route-count:${observedUnwindRoutes.length}`,
      ],
      routeEvidenceRefIds,
    );
  } else if (input.exitStatus.observationState === "known" && stressRequest !== null) {
    measuredUnwind = unavailableWrapperFact(
      "integration-missing",
      "wrapper-measured-unwind:no-observed-complete-capacity",
      routeEvidenceRefIds,
    );
  } else {
    measuredUnwind = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus], "producer-failed"),
      "wrapper-measured-unwind-unavailable",
      routeEvidenceRefIds,
    );
  }
  return { withdrawalTerms, measuredUnwind };
}

function buildWrapperLossAbsorptionFact(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): V9WrapperLocalDimensionFact {
  const { reviewedFormEvidence, controlEvidenceRefIds } = state;
  let lossAbsorptionEmergencyControls: V9WrapperLocalDimensionFact;
  if (
    context.asset.variantKind === "pure-wrapper" ||
    context.asset.variantKind === "savings-passthrough"
  ) {
    lossAbsorptionEmergencyControls = notApplicableWrapperFact(
      "wrapper-design-has-no-local-holder-loss-absorption-layer",
      reviewedFormEvidence,
    );
  } else {
    const localControls =
      context.asset.variantKind === "strategy-vault" || context.asset.variantKind === "risk-absorption"
        ? input.controls.filter(
            (control) =>
              control.controlKind !== "bridge" &&
              !input.dependencies.edges.some(
                (edge) =>
                  edge.pathKind === "serial-dependency" &&
                  edge.dependencyType === "wrapper" &&
                  (control.controllerAssetId === edge.upstreamAssetId ||
                    control.failureDomains.some(
                      (domain) =>
                        domain.kind === "mint-control" &&
                        domain.key === `asset:${edge.upstreamAssetId}`,
                    )),
              ),
          )
        : [];
    const reviewableLocalControls = localControls.filter((control) =>
      isReviewableLocalControlStatus(control.status),
    );
    if (input.controlStatus.observationState === "known" || reviewableLocalControls.length > 0) {
      const controlsForRisk =
        input.controlStatus.observationState === "known" ? localControls : reviewableLocalControls;
      const controlRisks = controlsForRisk.map(wrapperControlRisk);
      const partialControlReview = input.controlStatus.observationState !== "known";
      lossAbsorptionEmergencyControls =
        controlRisks.length > 0
          ? reviewedWrapperFact(
              context,
              worstWrapperRisk([
                ...controlRisks.map((risk) => risk.assessment),
                ...(context.asset.variantKind === "risk-absorption" ? (["moderate"] as const) : []),
              ]),
              [
                ...controlRisks.flatMap((risk) => risk.signals),
                ...(partialControlReview ? ["wrapper-local-controls-partial-review"] : []),
                ...(context.asset.variantKind === "risk-absorption"
                  ? ["wrapper-holder-bears-protocol-loss-absorption"]
                  : ["strategy-vault-holder-loss-controls-reviewed"]),
              ],
              controlEvidenceRefIds,
            )
          : input.controlStatus.observationState === "known" &&
              input.controls.some((control) => control.controlKind !== "bridge")
            ? context.asset.variantKind === "risk-absorption"
              ? reviewedWrapperFact(
                  context,
                  "moderate",
                  ["wrapper-holder-bears-protocol-loss-absorption"],
                  reviewedFormEvidence,
                )
              : notApplicableWrapperFact(
                  "wrapper-emergency-controls-priced-through-parent",
                  controlEvidenceRefIds,
                )
            : unavailableWrapperFact(
                "integration-missing",
                "wrapper-emergency-control-review-has-no-local-controls",
                controlEvidenceRefIds,
              );
    } else {
      lossAbsorptionEmergencyControls = unavailableWrapperFact(
        wrapperFactDisposition(context, [input.controlStatus]),
        "wrapper-loss-absorption-or-emergency-control-review-unavailable",
        controlEvidenceRefIds,
      );
    }
  }
  return lossAbsorptionEmergencyControls;
}

export function buildWrapperLocalFacts(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
): V9WrapperLocalFacts {
  const wrapperEdge = input.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form = resolveWrapperForm(context.asset, input.dependencies);
  const formEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.implementation.status.evidenceRefIds,
    ...input.dependencies.status.evidenceRefIds,
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  if (form === null) {
    return V9WrapperLocalFactsSchema.parse({
      schemaVersion: 1,
      applicability: "not-wrapper",
      evidenceRefIds:
        formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)],
    });
  }
  const reviewedFormEvidence =
    formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)];
  const controlEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.controlStatus.evidenceRefIds,
    ...input.economicControlReview.mint.status.evidenceRefIds,
    ...input.controls.flatMap((control) => control.status.evidenceRefIds),
  ]);
  const reserveEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.reserveStatus.evidenceRefIds,
    ...input.reserveExposures.flatMap((exposure) => exposure.status.evidenceRefIds),
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  const allocationEvidenceRefIds =
    context.asset.wrapperAllocationReview?.scopeKind !== "whole-allocation"
      ? []
      : uniqueEvidenceRefIds([
          ...componentResearchEvidence(context, "wrapper-local:custodyEscrow"),
          ...componentResearchEvidence(context, "wrapper-local:leverage"),
          ...componentResearchEvidence(context, "wrapper-local:rehypothecationCorrelation"),
        ]);
  const routeEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.exitStatus.evidenceRefIds,
    ...input.exitRoutes.flatMap((route) => [
      ...route.status.evidenceRefIds,
      ...route.settlementEvidenceRefIds,
      ...route.output.status.evidenceRefIds,
      ...(route.output.valuation?.evidenceRefIds ?? []),
    ]),
  ]);
  const state: WrapperLocalBuildState = {
    form,
    wrapperEdge,
    reviewedFormEvidence,
    controlEvidenceRefIds,
    reserveEvidenceRefIds,
    allocationEvidenceRefIds,
    routeEvidenceRefIds,
  };
  const {
    contractMutability,
    custodyEscrow,
    strategyComplexity,
    leverage,
    rehypothecationCorrelation,
    shareAccountingNavOracle,
  } = buildWrapperStructuralDimensions(context, input, state);
  assertDirectSerialWrapperFactDispositionInvariant(context, isDirectSerialWrapper(context, form, wrapperEdge), {
    custodyEscrow,
    leverage,
    rehypothecationCorrelation,
  });
  const { withdrawalTerms, measuredUnwind } = buildWrapperExitDimensions(
    context,
    input,
    state,
  );
  const lossAbsorptionEmergencyControls = buildWrapperLossAbsorptionFact(
    context,
    input,
    state,
  );

  const facts: V9ApplicableWrapperLocalFacts = {
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: "reviewed",
    formSignals: [
      `wrapper-form:${form}`,
      `wrapper-form-source:${context.asset.variantKind ?? "serial-wrapper-dependency"}`,
      ...(context.asset.wrapperOperator === undefined
        ? []
        : [`wrapper-operator:${context.asset.wrapperOperator}`]),
    ],
    formEvidenceRefIds: reviewedFormEvidence,
    ...(context.asset.parentBackingInheritance === undefined ? {} : {
      parentBackingInheritance: {
        state: context.asset.parentBackingInheritance.state,
        reason: context.asset.parentBackingInheritance.reason,
        evidenceRefIds: componentResearchEvidence(context, "wrapper-local:parentBackingInheritance"),
      },
    }),
    facts: {
      contractMutability,
      custodyEscrow,
      strategyComplexity,
      leverage,
      rehypothecationCorrelation,
      shareAccountingNavOracle,
      withdrawalTerms,
      measuredUnwind,
      lossAbsorptionEmergencyControls,
    },
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-documented-parent-loss-absorption-credit"],
      evidenceRefIds: [],
    },
  };
  for (const [factorKey, fact] of Object.entries(facts.facts)) {
    if (fact.disposition === "reviewed" || fact.disposition === "not-applicable") continue;
    const missing = missingLocalFact(context, {
      componentKey: `wrapper-local:${factorKey}`, reasonCode: "missing-pillar-evidence", ownerDomain: "evidence",
      responsibility: "unresearched", policyRuleId: "v9.wrapper.local-facts",
      message: `The wrapper-local ${factorKey} risk datum has not been established.`,
      evidenceRefIds: fact.evidenceRefIds,
      causeScope: { pillar: "backing", componentKey: "wrapper-local", factorKey, routeKey: null,
        exposureId: null, requiredDatum: factorKey },
    });
    fact.status = missing.status;
    fact.disposition = context.gaps.get(missing.gapId)!.responsibility as Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">;
  }
  return V9WrapperLocalFactsSchema.parse(facts);
}
