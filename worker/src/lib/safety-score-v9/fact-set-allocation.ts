import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import {
  allocationReviewClockSec,
  V9AllocationScoredDimensionSchema,
  type V9AllocationScoredDimension,
  type V9AllocationScopeFact,
  type V9ScopedAllocationClaim,
  type V9AllocationScopeIdentityReview,
} from "@shared/types/safety-score-v9-allocation";
import type { V9EffectiveDependenciesV3, V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import { V9WrapperRiskAssessmentSchema, type V9WrapperRiskAssessment } from "@shared/types/safety-score-v9-wrapper";
import { addEvidence, type AssetBuildContext } from "./fact-set-context";
import { computeSafetyScoreV9ReserveExposureKey } from "./fact-set-schema";

type AllocationPolicy = typeof V9_CANDIDATE_POLICY_V1;
const RISK_ORDER = Object.fromEntries(V9WrapperRiskAssessmentSchema.options.map((value, index) => [value, index])) as Record<V9WrapperRiskAssessment, number>;

export function resolveAllocationParentBoundary(claim: V9ScopedAllocationClaim, dependencies: V9EffectiveDependenciesV3): boolean {
  const target = claim.target;
  if (target.kind !== "parent-claim") return false;
  // This only admits explanatory risk attribution. It never marks a local
  // dimension complete or grants parent Backing/holder-rights/supervision credit.
  return dependencies.diagnostics.graphState === "valid" && dependencies.status.observationState === "known" &&
    dependencies.edges.some((edge) => edge.edgeKey === target.edgeKey && edge.upstreamAssetId === target.upstreamAssetId &&
      (edge.economicRole === "serial-claim" || edge.economicRole === "basket-exposure"));
}

function matchesAllocationIdentity(
  deployment: V9AllocationScopeIdentityReview["deployments"][number],
  identities: ReadonlyMap<string, V9AllocationScopeIdentityReview["deployments"][number]>,
  claim: V9ScopedAllocationClaim,
  clock: number,
  maxAgeSec: number,
): boolean {
  const identity = identities.get(`${deployment.chain}:${deployment.address}`);
  if (!identity || identity.codeKind !== deployment.codeKind ||
    identity.observedAtSec > clock || clock - identity.observedAtSec > maxAgeSec ||
    deployment.observedAtSec > clock || clock - deployment.observedAtSec > maxAgeSec ||
    identity.observedAtSec !== deployment.observedAtSec || identity.block !== deployment.block ||
    identity.sourceUrl !== deployment.sourceUrl ||
    (identity.codeKind === "proxy" && deployment.codeKind === "proxy" && identity.implementation !== deployment.implementation)) return false;
  let sourceBound = false;
  for (const source of claim.sources) if (source.url === identity.sourceUrl) { sourceBound = true; break; }
  if (!sourceBound) return false;
  for (const observation of claim.observations) {
    if (observation.sourceUrl === identity.sourceUrl && observation.observedAtSec === identity.observedAtSec) return true;
  }
  return false;
}

export function buildAllocationScopeFacts(
  context: AssetBuildContext,
  input: { dependencies: V9EffectiveDependenciesV3; reserveStatus: V9FactStatusV2; reserveExposures: readonly V9ReserveExposureFactV2[] },
  policy: AllocationPolicy = V9_CANDIDATE_POLICY_V1,
): V9AllocationScopeFact[] {
  const review = context.asset.wrapperAllocationReview;
  if (review?.scopeKind !== "per-dimension") return [];
  const rules = policy.policy.semantic.formula.wrapperAllocationScope;
  const clock = context.fixedInput.clockSec;
  const maxAgeSec = policy.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
  const sourceGenerationId = context.extension.sources.researchOverlays.generationId;
  const identities = new Map<string, V9AllocationScopeIdentityReview["deployments"][number]>();
  for (const row of context.asset.allocationScopeIdentityReview?.deployments ?? []) identities.set(`${row.chain}:${row.address}`, row);
  const parentDeploymentKeys = new Map<string, readonly string[]>();
  for (const claim of review.claims) {
    const proof = claim.target.kind === "deployment" ? claim.target.idleCustodyProof : undefined;
    if (proof && !parentDeploymentKeys.has(proof.upstreamAssetId)) {
      const parent = context.extension.assets.find((asset) => asset.assetId === proof.upstreamAssetId);
      parentDeploymentKeys.set(proof.upstreamAssetId, parent?.allocationScopeIdentityReview?.registeredDeploymentKeys ?? []);
    }
  }
  const exposures = new Map(input.reserveExposures.map((exposure) => [exposure.exposureKey, exposure]));
  const liveRows = context.fixedInput.liveReserveMap[context.asset.assetId] ?? [];
  const reserveRows = liveRows.length > 0 ? liveRows : context.asset.reviewedStaticReserveRows?.rows ?? [];
  const sourceKeys = new Set<string>();
  for (const row of reserveRows) {
    if (row.sourceKey && exposures.has(computeSafetyScoreV9ReserveExposureKey(row))) sourceKeys.add(row.sourceKey);
  }
  const envelopeKnown = input.reserveStatus.observationState === "known" && input.reserveExposures.length > 0 &&
    sourceKeys.size === input.reserveExposures.length && input.reserveExposures.every((row) => row.status.observationState === "known") &&
    input.reserveExposures.reduce((sum, row) => sum + row.weight, 0) === 1;
  const custody = context.asset.wrapperCustodyReview;
  const scopeFamily = input.reserveExposures.some((row) => row.assetClass === "private-credit") ? "privateCredit" :
    envelopeKnown && custody?.custodyModel === "onchain" && custody.knownUnknownExposureShare === 0 &&
    input.reserveExposures.every((row) => row.assetClass === "protocol-position") ? "contractOnly" : "mixedInstitutional";
  const required = rules.requiredScopes[scopeFamily];
  const facts: V9AllocationScopeFact[] = [];
  for (const claim of review.claims) {
    let rejectionReason: V9AllocationScopeFact["rejectionReason"] = null;
    const reviewSec = allocationReviewClockSec(claim.reviewedAt);
    if (reviewSec > clock || claim.observedAtSec > clock) rejectionReason = "future-observation";
    else if (clock >= claim.expiresAtSec || clock - Math.min(reviewSec, claim.observedAtSec) > maxAgeSec) rejectionReason = "expired";
    else if (claim.target.kind === "deployment") {
      const target = claim.target.deployment;
      if (!claim.target.reachableSetComplete || !matchesAllocationIdentity(target, identities, claim, clock, maxAgeSec)) rejectionReason = "identity-unmatched";
      for (const deployment of claim.target.reachableTargets) {
        if (!matchesAllocationIdentity(deployment, identities, claim, clock, maxAgeSec)) {
          rejectionReason = "identity-unmatched";
          break;
        }
      }
      const idleProof = claim.target.idleCustodyProof;
      if (rejectionReason === null && idleProof &&
        !(input.dependencies.diagnostics.graphState === "valid" && input.dependencies.status.observationState === "known" &&
          parentDeploymentKeys.get(idleProof.upstreamAssetId)?.includes(`${target.chain}:${idleProof.parentTokenAddress}`) &&
          input.dependencies.edges.some((edge) => edge.economicRole === "serial-claim" &&
            edge.upstreamAssetId === idleProof.upstreamAssetId))) rejectionReason = "parent-claim-unmatched";
    } else if (claim.target.kind === "reserve-leg" && claim.target.sourceKey !== null && !sourceKeys.has(claim.target.sourceKey)) rejectionReason = "reserve-leg-unmatched";
    else if (claim.target.kind === "parent-claim" && !resolveAllocationParentBoundary(claim, input.dependencies)) rejectionReason = "parent-claim-unmatched";
    if (rejectionReason === null && claim.coverage.kind === "whole-dimension" && (!envelopeKnown ||
      claim.coverage.reserveSourceKeys.length !== sourceKeys.size || claim.coverage.reserveSourceKeys.some((key) => !sourceKeys.has(key)))) rejectionReason = "reserve-coverage-unestablished";
    let assessment: V9WrapperRiskAssessment | null = null;
    if (claim.disposition === "reviewed" || claim.disposition === "not-applicable") {
      const map = claim.dimension === "leverage" ? rules.leverageAssessments : claim.dimension === "rehypothecationCorrelation" ? rules.reuseAssessments : claim.dimension === "custodyEscrow" ? rules.custodyAssessments : null;
      if (map !== null && Object.prototype.hasOwnProperty.call(map, claim.statement)) assessment = (map as Record<string, V9WrapperRiskAssessment>)[claim.statement]!;
    }
    const evidenceRefIds: string[] = [];
    if (rejectionReason === null) {
      for (const source of claim.sources) {
        evidenceRefIds.push(addEvidence(context, createV9EvidenceReference({
          evidenceId: `${context.asset.assetId}:allocation-scope:${claim.claimKey}:${domainDigest("safety-score-v9.allocation-source.v1", source).slice(0, 16)}`,
          sourceId: "safety-score-v9.scoped-allocation-review", sourceGenerationId,
          disposition: "observed", observedAtSec: claim.observedAtSec, url: source.url,
          contentSha256: domainDigest("safety-score-v9.scoped-allocation-claim.v1", claim),
          maxAgeSec: Math.min(maxAgeSec, claim.expiresAtSec - claim.observedAtSec),
        }, clock)));
      }
    }
    facts.push({ ...claim, admitted: rejectionReason === null, assessment: rejectionReason === null ? assessment : null,
      rejectionReason, evidenceRefIds: evidenceRefIds.sort(compareText), maxAgeSec, sourceGenerationId });
  }
  const wholeBookByScope = new Map<string, V9AllocationScopeFact[]>();
  const undisclosedScopes = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.dimension}:${fact.layer}`;
    if (fact.disposition === "issuer-undisclosed") undisclosedScopes.add(key);
    if (fact.coverage?.kind === "whole-dimension") {
      const scoped = wholeBookByScope.get(key) ?? [];
      scoped.push(fact);
      wholeBookByScope.set(key, scoped);
    }
  }
  // Two whole-book proofs for the same layer cannot manufacture coverage by
  // double-counting a roster. Keep narrow observations but reject combination.
  for (const dimension of V9AllocationScoredDimensionSchema.options) {
    for (const layer of required[dimension]) {
      const scopeKey = `${dimension}:${layer}`;
      const candidates = wholeBookByScope.get(scopeKey) ?? [];
      if (candidates.length > 1) for (const fact of candidates) { fact.admitted = false; fact.assessment = null; fact.rejectionReason = "overlapping-scope"; }
      const covered = candidates.length === 1 && candidates[0]!.admitted &&
        (candidates[0]!.disposition === "reviewed" || candidates[0]!.disposition === "not-applicable") && candidates[0]!.assessment !== null &&
        !undisclosedScopes.has(scopeKey);
      if (!covered) facts.push({
        claimKey: `required:${dimension}:${layer}`, dimension, layer, target: null, coverage: null,
        disposition: "integration-missing", statement: null, rationale: `Required ${scopeFamily} scope has no admitted whole-dimension proof`,
        reviewedAt: null, observedAtSec: null, expiresAtSec: null, sources: [], observations: [],
        admitted: false, assessment: null, rejectionReason: "required-scope-unresolved", evidenceRefIds: [], maxAgeSec, sourceGenerationId,
      });
    }
  }
  return facts.sort((left, right) => compareText(left.claimKey, right.claimKey));
}

export function resolveAllocationDimensionCoverage(facts: readonly V9AllocationScopeFact[], dimension: V9AllocationScoredDimension) {
  const rows = facts.filter((fact) => fact.dimension === dimension);
  const assessments = rows.filter((row) => row.admitted && row.disposition !== "inherited-parent" && row.assessment !== null).map((row) => row.assessment!);
  const assessment = assessments.reduce<V9WrapperRiskAssessment | null>((worst, value) => worst === null || RISK_ORDER[value] > RISK_ORDER[worst] ? value : worst, null);
  return {
    complete: rows.length > 0 && !rows.some((row) => row.rejectionReason === "required-scope-unresolved" || row.disposition === "issuer-undisclosed") && assessment !== null,
    assessment,
    signals: rows.map((row) => `allocation-scope:${row.claimKey}:${row.admitted ? row.disposition : row.rejectionReason}`),
    evidenceRefIds: [...new Set(rows.filter((row) => row.admitted).flatMap((row) => row.evidenceRefIds))].sort(compareText),
  };
}
