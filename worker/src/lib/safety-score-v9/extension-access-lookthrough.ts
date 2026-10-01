import overlayJson from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import { V9AccessClaimGraphSchema, V9AccessClaimGraphReviewSchema, V9AccessLookthroughOverlaySchema, type V9AccessClaimGraph, type V9AccessClaimGraphReview } from "@shared/types/safety-score-v9-access-lookthrough";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { requiredStatus, type ReviewEvidenceBuilder } from "./extension-shared";

const overlay = V9AccessLookthroughOverlaySchema.parse(overlayJson);
const reviews = new Map(overlay.reviews.map((review) => [review.assetId, review]));
export function getSafetyScoreV9AccessClaimGraphReview(assetId: string): V9AccessClaimGraphReview | undefined {
  return reviews.get(assetId);
}
export function computeSafetyScoreV9AccessClaimGraphReviewsDigest(overrides?: Iterable<V9AccessClaimGraphReview>): string {
  const selected = overrides ? { ...overlay, reviews: [...overrides].sort((a, b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) } : overlay;
  return domainDigest("safety-score-v9.access-lookthrough-reviews.v1", selected);
}
/** Dates are admitted before evidence creation; future reviews cannot quarantine other assets. */
export function buildSafetyScoreV9AccessClaimGraph(args: {
  assetId: string; clockSec: number; generationId: string; evidence: ReviewEvidenceBuilder;
  review?: V9AccessClaimGraphReview;
}): V9AccessClaimGraph | undefined {
  const candidate = args.review ?? getSafetyScoreV9AccessClaimGraphReview(args.assetId);
  if (!candidate) return undefined;
  const review = V9AccessClaimGraphReviewSchema.parse(candidate);
  if (review.assetId !== args.assetId) throw new Error("Access claim graph receiving identity mismatch");
  const maxAge = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.accessReviewMaxAgeSec;
  const unresolved: V9AccessClaimGraph["unresolved"] = [];
  function compileStatus(metadata: V9AccessClaimGraphReview["nodes"][number]["review"], componentKey: string, nodeKey: string) {
    const reviewedSec = Date.parse(metadata.reviewedAt) / 1000;
    const future = reviewedSec > args.clockSec;
    const stale = args.clockSec - reviewedSec > maxAge;
    const evidenceKeys = future ? [] : args.evidence.add({
      componentKeys: [componentKey], sourceId: "safety-score-v9.access-lookthrough-review",
      reviewedAt: metadata.reviewedAt, sources: metadata.sources.map((url) => ({ label: "Reviewed access claim evidence", url })),
      confidence: "manual-review", payload: { graph: review, componentKey, metadata }, maxAgeSec: maxAge,
    });
    if (future || stale) unresolved.push({ branchKey: `${componentKey}:admission`, nodeKey, reason: future ? "future-dated" : "stale", responsibility: metadata.responsibility,
      status: requiredStatus("v9.access.freeze-review", future ? "missing" : "stale", `${componentKey}:admission`, evidenceKeys) });
    return requiredStatus("v9.access.freeze-review", future ? "missing" : stale ? "stale" : "known", componentKey, evidenceKeys);
  }
  const nodes = review.nodes.map(({ review: metadata, ...node }) => ({ ...node, status: compileStatus(metadata, `access:graph:node:${node.nodeKey}`, node.nodeKey) }));
  const edges = review.edges.map(({ review: metadata, ...edge }) => ({ ...edge,
    weight: edge.basis.kind === "serial-claim" && edge.basis.entireClaim && edge.enabled && edge.reachesHeldClaim ? 1 : null,
    status: compileStatus(metadata, `access:graph:edge:${edge.edgeKey}`, edge.fromNodeKey),
  }));
  const authorities = review.authorities.map(({ review: metadata, ...authority }) => ({ ...authority, status: compileStatus(metadata, `access:graph:authority:${authority.authorityKey}`, authority.nodeKey) }));
  const partitions = review.partitions.map(({ review: metadata, ...partition }) => ({ ...partition,
    denominatorEstablished: edges.filter((e) => e.partitionKey === partition.partitionKey).length > 0 && edges.filter((e) => e.partitionKey === partition.partitionKey).every((e) => e.basis.kind === "serial-claim" && e.basis.entireClaim),
    status: compileStatus(metadata, `access:graph:partition:${partition.partitionKey}`, partition.nodeKey),
  }));
  for (const { review: metadata, ...branch } of review.unresolved) {
    const status = compileStatus(metadata, `access:graph:unresolved:${branch.branchKey}`, branch.nodeKey);
    unresolved.push({ ...branch, status: requiredStatus("v9.access.freeze-review", status.observationState === "known" ? "bounded-unknown" : status.observationState, `access:graph:unresolved:${branch.branchKey}`, status.evidenceRefIds) });
  }
  return V9AccessClaimGraphSchema.parse({ assetId: args.assetId, graphKey: review.graphKey, rootNodeKey: review.rootNodeKey, clockSec: args.clockSec, generationId: args.generationId, nodes, edges, authorities, partitions, unresolved });
}
