import { resolveChainId } from "@shared/types/chain-identity";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { allocationReviewClockSec, type V9AllocationScopeIdentityReview } from "@shared/types/safety-score-v9-allocation";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { confidenceForResearch, type V9ExtensionRegistryMeta } from "./extension-shared";
import reviewsAsset from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperAllocationReviewSchema, type SafetyScoreV9WrapperAllocationReview } from "@shared/types/safety-score-v9-allocation";
import { SafetyScoreV9WrapperLocalReviewSchema, type SafetyScoreV9WrapperLocalReview } from "@shared/types/safety-score-v9-wrapper-local-review";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { z } from "zod";

export const SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST = domainDigest(
  "safety-score-v9.wrapper-allocation-reviews.v1", reviewsAsset,
);
export const SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST = domainDigest("safety-score-v9.wrapper-local-reviews.v1", reviewsAsset.localReviews);

// Only malformed global envelopes/identities invalidate the cohort. Claim bytes
// stay lazy inside the caller's asset quarantine boundary for both economic lanes.
const rowIdentity = z.object({ assetId: z.string().trim().min(1) }).passthrough();
const envelope = z.object({ schemaVersion: z.literal(1), reviews: z.array(rowIdentity), localReviews: z.array(rowIdentity).optional() }).strict().parse(reviewsAsset);
function indexReviews(rows: readonly { assetId: string }[]): Map<string, unknown[]> {
  const byAsset = new Map<string, unknown[]>();
  for (const row of rows) {
    const entries = byAsset.get(row.assetId) ?? [];
    entries.push(row);
    byAsset.set(row.assetId, entries);
  }
  return byAsset;
}
const reviewsByAsset = indexReviews(envelope.reviews);
const rowsByAsset = indexReviews(envelope.localReviews ?? []);

export function getSafetyScoreV9WrapperAllocationReview(assetId: string, clockSec: number): SafetyScoreV9WrapperAllocationReview | null {
  const rows = reviewsByAsset.get(assetId);
  if (!rows) return null;
  if (rows.length !== 1) throw new Error(`Duplicate wrapper allocation review for ${assetId}`);
  const review = SafetyScoreV9WrapperAllocationReviewSchema.parse(rows[0]);
  if (review.scopeKind === "per-dimension") return review;
  const clockMs = clockSec * 1_000;
  return Date.parse(`${review.reviewedAt}T00:00:00.000Z`) <= clockMs && clockMs < Date.parse(`${review.expiresAt}T00:00:00.000Z`) ? review : null;
}
export function getSafetyScoreV9WrapperLocalReviews(assetId: string): SafetyScoreV9WrapperLocalReview[] {
  const reviews = (rowsByAsset.get(assetId) ?? []).map((row) => SafetyScoreV9WrapperLocalReviewSchema.parse(row));
  if (new Set(reviews.map((review) => review.kind)).size !== reviews.length) throw new Error(`Duplicate wrapper-local review kind for ${assetId}`);
  return reviews;
}

export function addWrapperCustodyEvidence(meta: V9ExtensionRegistryMeta, evidence: ReviewEvidenceBuilder): void {
  const review = meta.custodyProfile;
  if (!review) return;
  evidence.add({
    componentKeys: [
      "wrapper-local:custodyEscrow",
      "wrapper-local:rehypothecationCorrelation",
    ],
    sourceId: "stablecoin-meta.custody-profile",
    reviewedAt: review.reviewedAt,
    publishedBy: "unknown",
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}

export function addWrapperAllocationEvidence(
  review: SafetyScoreV9WrapperAllocationReview | null,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): void {
  if (!review) return;
  if (review.scopeKind === "per-dimension") {
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
    for (const claim of review.claims) {
      if (allocationReviewClockSec(claim.reviewedAt) > clockSec || claim.observedAtSec > clockSec ||
        clockSec >= claim.expiresAtSec || clockSec - claim.observedAtSec > maxAgeSec) continue;
      const keys: string[] = [];
      for (const source of claim.sources) {
        const contentSha256 = domainDigest("safety-score-v9.scoped-allocation-claim.v1", { claim, source });
        const evidenceKey = `allocation-scope:${claim.claimKey}:${contentSha256.slice(0, 16)}`;
        evidence.evidence.set(evidenceKey, {
          evidenceKey, sourceId: "safety-score-v9.scoped-allocation-review",
          observedAtSec: claim.observedAtSec, publishedAtSec: null, publishedBy: "unknown",
          url: source.url, contentSha256, confidence: "verified",
          maxAgeSec: Math.min(maxAgeSec, claim.expiresAtSec - claim.observedAtSec),
        });
        keys.push(evidenceKey);
      }
      evidence.bindings.set(`allocation-scope:${claim.claimKey}`, new Set(keys));
    }
    return;
  }
  evidence.add({
    componentKeys: [
      "wrapper-local:custodyEscrow",
      "wrapper-local:leverage",
      "wrapper-local:rehypothecationCorrelation",
    ],
    sourceId: "safety-score-v9.wrapper-allocation-review",
    reviewedAt: review.reviewedAt,
    publishedBy: "unknown",
    confidence: "verified",
    sources: review.sources,
    payload: review,
    maxAgeSec:
      Math.floor(Date.parse(`${review.expiresAt}T00:00:00.000Z`) / 1_000) -
      Math.floor(Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1_000),
  });
}

export function buildAllocationScopeIdentityReview(meta: V9ExtensionRegistryMeta, clockSec: number): V9AllocationScopeIdentityReview {
  const deployments: V9AllocationScopeIdentityReview["deployments"] = [];
  const registeredDeploymentKeys = (meta.contracts ?? []).flatMap((contract) => {
    const chain = resolveChainId(contract.chain);
    return chain === null ? [] : [canonicalExitRouteScopedKey(chain, contract.address)];
  }).sort(compareText);
  const upgrade = meta.mintAuthority?.upgradeability;
  if (upgrade?.observedAt && upgrade.observedBlock !== undefined && upgrade.sources.length > 0) {
    const observedAtSec = allocationReviewClockSec(upgrade.observedAt);
    const sourceUrl = upgrade.sources[0]!.url;
    for (const contract of meta.contracts ?? []) {
      const chain = resolveChainId(contract.chain);
      if (chain === null) continue;
      const address = canonicalExitRouteScopedId(chain, contract.address);
      const deploymentKey = `${chain}:${address}`;
      // Unscoped addresses never identify a deployment across multiple chains.
      const scoped = upgrade.deploymentRefs?.some((ref) => normalizeDeploymentId(ref) === deploymentKey) ||
        (meta.contracts?.length === 1);
      if (!scoped) continue;
      if (upgrade.model === "immutable") {
        deployments.push({ codeKind: "immutable", chain, address, observedAtSec, block: upgrade.observedBlock, sourceUrl });
      } else if (upgrade.proxyAddresses?.some((proxy) => canonicalExitRouteScopedId(chain, proxy) === address) &&
        upgrade.implementationAddresses?.length === 1) {
        deployments.push({ codeKind: "proxy", chain, address, implementation: canonicalExitRouteScopedId(chain, upgrade.implementationAddresses[0]!),
          observedAtSec, block: upgrade.observedBlock, sourceUrl });
      }
    }
  }
  const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
  for (const contract of meta.contracts ?? []) {
    const chain = resolveChainId(contract.chain);
    if (chain === null) continue;
    const address = canonicalExitRouteScopedId(chain, contract.address);
    const deploymentKey = `${chain}:${address}`;
    // Native observations retain their existing ownership and admission path.
    if (deployments.some((deployment) => deployment.chain === chain && deployment.address === address)) continue;
    const routes = (meta.bridgeRouteRisk?.routes ?? []).filter((route) =>
      route.issuanceModel === "bridge-representation" && route.routeClass !== "native" &&
      resolveChainId(route.destinationChain) === chain &&
      canonicalExitRouteScopedId(chain, route.contractAddress) === address);
    if (routes.length !== 1) continue;
    const route = routes[0]!;
    const identity = route.deploymentIdentity;
    if (route.reviewDisposition !== "reviewed" || !route.observedAt || !identity ||
      normalizeDeploymentId(route.id) !== deploymentKey || identity.chain !== chain ||
      canonicalExitRouteScopedId(chain, identity.address) !== address ||
      route.observedBlock !== identity.block || !route.sources?.some((source) => source.url === identity.sourceUrl)) continue;
    const routeObservedAtSec = allocationReviewClockSec(route.observedAt);
    if (routeObservedAtSec > clockSec || clockSec - routeObservedAtSec > maxAgeSec ||
      identity.observedAtSec > routeObservedAtSec || identity.observedAtSec > clockSec ||
      clockSec - identity.observedAtSec > maxAgeSec) continue;
    deployments.push(identity.codeKind === "immutable"
      ? { ...identity, chain, address }
      : { ...identity, chain, address, implementation: canonicalExitRouteScopedId(chain, identity.implementation) });
  }
  return { assetId: meta.id, registeredDeploymentKeys, deployments };
}
