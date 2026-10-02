import { z } from "zod";
import policy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { CanonicalChainIdSchema, CanonicalTextSchema, FractionSchema, UnixSecondsSchema, uniqueKeyedCollectionSchema, reviewedAssetCollectionEnvelopeSchema } from "./safety-schema-primitives";
import { canonicalArrayBy, canonicalTextArray, V9EvidenceResponsibilitySchema, V9FactStatusV2Schema } from "./safety-score-v9-fact-primitives";
import { CanonicalFailureDomainsSchema } from "./safety-score-v9-fact-input-primitives";

const vocabulary = policy.semantic.accessLookthrough;
export const V9AccessEdgeKindSchema = z.enum(vocabulary.edgeKinds as [string, ...string[]]);
export const V9AccessCoverageStateSchema = z.enum(vocabulary.coverageStates as [string, ...string[]]);
export const V9AccessAuthorityCapabilitySchema = z.enum(vocabulary.authorityCapabilities as [string, ...string[]]);
export const V9AccessUnresolvedReasonSchema = z.enum(vocabulary.unresolvedReasons as [string, ...string[]]);
export const V9AccessLookthroughPolicySchema = z.object({
  edgeKinds: z.array(V9AccessEdgeKindSchema), coverageStates: z.array(V9AccessCoverageStateSchema),
  authorityCapabilities: z.array(V9AccessAuthorityCapabilitySchema), unresolvedReasons: z.array(V9AccessUnresolvedReasonSchema),
  scopeBasis: z.literal("admitted-current-claim-graph"), aggregation: z.literal("disjoint-position-union"),
  transferInheritance: z.literal("never"), unpricedShares: z.literal("null"), cycleTreatment: z.literal("unknown-affected-component"),
}).strict();
export const V9AccessClaimIdentitySchema = z.object({ chainId: CanonicalChainIdSchema, claimAddress: CanonicalTextSchema }).strict();
const ReviewSchema = z.object({ reviewedAt: z.string().datetime(), sources: z.array(z.string().url()).min(1), responsibility: V9EvidenceResponsibilitySchema }).strict();
const NodeShape = {
  nodeKey: CanonicalTextSchema, identity: V9AccessClaimIdentitySchema, assetId: CanonicalTextSchema.nullable(),
  noCurrentReach: z.boolean(),
};
const AuthorityShape = {
  authorityKey: CanonicalTextSchema, nodeKey: CanonicalTextSchema, actingDeployment: V9AccessClaimIdentitySchema,
  controllerKey: CanonicalTextSchema.nullable(), capability: V9AccessAuthorityCapabilitySchema,
  reach: z.enum(["current", "possible", "none", "unknown"]), failureDomains: CanonicalFailureDomainsSchema,
};
const BasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reserve-position"), exposureKey: CanonicalTextSchema, sourceKey: CanonicalTextSchema.nullable() }).strict(),
  z.object({ kind: z.literal("serial-claim"), dependencyEdgeKey: CanonicalTextSchema.nullable(), entireClaim: z.boolean(), currentImplementation: CanonicalTextSchema }).strict(),
  z.object({ kind: z.literal("selected-observation") }).strict(),
]);
const EdgeShape = {
  edgeKey: CanonicalTextSchema, fromNodeKey: CanonicalTextSchema, toNodeKey: CanonicalTextSchema,
  kind: V9AccessEdgeKindSchema, positionKey: CanonicalTextSchema, partitionKey: CanonicalTextSchema,
  basis: BasisSchema, reachesHeldClaim: z.boolean(), enabled: z.boolean(),
};
const PartitionShape = { partitionKey: CanonicalTextSchema, nodeKey: CanonicalTextSchema, disjoint: z.boolean(), complete: z.boolean() };
const UnresolvedShape = { branchKey: CanonicalTextSchema, nodeKey: CanonicalTextSchema, reason: V9AccessUnresolvedReasonSchema, responsibility: V9EvidenceResponsibilitySchema };
export const V9AccessClaimGraphReviewSchema = z.object({
  assetId: CanonicalTextSchema, graphKey: CanonicalTextSchema, rootNodeKey: CanonicalTextSchema,
  nodes: canonicalArrayBy(z.object({ ...NodeShape, review: ReviewSchema }).strict(), (v) => v.nodeKey, 1),
  edges: canonicalArrayBy(z.object({ ...EdgeShape, review: ReviewSchema }).strict(), (v) => v.edgeKey),
  authorities: canonicalArrayBy(z.object({ ...AuthorityShape, review: ReviewSchema }).strict(), (v) => v.authorityKey),
  partitions: canonicalArrayBy(z.object({ ...PartitionShape, review: ReviewSchema }).strict(), (v) => v.partitionKey),
  unresolved: canonicalArrayBy(z.object({ ...UnresolvedShape, review: ReviewSchema }).strict(), (v) => v.branchKey),
}).strict();
export const V9AccessLookthroughOverlaySchema = uniqueKeyedCollectionSchema({ itemSchema: V9AccessClaimGraphReviewSchema, collectionKey: "reviews", duplicateMessage: "Duplicate access graph asset", noteSchema: CanonicalTextSchema });
export const V9AccessLookthroughOverlayEnvelopeSchema = reviewedAssetCollectionEnvelopeSchema("reviews", CanonicalTextSchema);
export const V9AccessClaimGraphSchema = z.object({
  assetId: CanonicalTextSchema, graphKey: CanonicalTextSchema, rootNodeKey: CanonicalTextSchema,
  clockSec: UnixSecondsSchema, generationId: CanonicalTextSchema,
  nodes: canonicalArrayBy(z.object({ ...NodeShape, status: V9FactStatusV2Schema }).strict(), (v) => v.nodeKey, 1),
  edges: canonicalArrayBy(z.object({ ...EdgeShape, weight: FractionSchema.nullable(), status: V9FactStatusV2Schema }).strict(), (v) => v.edgeKey),
  authorities: canonicalArrayBy(z.object({ ...AuthorityShape, status: V9FactStatusV2Schema }).strict(), (v) => v.authorityKey),
  partitions: canonicalArrayBy(z.object({ ...PartitionShape, denominatorEstablished: z.boolean(), status: V9FactStatusV2Schema }).strict(), (v) => v.partitionKey),
  unresolved: canonicalArrayBy(z.object({ ...UnresolvedShape, status: V9FactStatusV2Schema }).strict(), (v) => v.branchKey),
}).strict().superRefine((graph, ctx) => {
  const nodes = new Set(graph.nodes.map((n) => n.nodeKey));
  const partitions = new Map(graph.partitions.map((p) => [p.partitionKey, p]));
  if (!nodes.has(graph.rootNodeKey)) ctx.addIssue({ code: "custom", path: ["rootNodeKey"], message: "Missing receiving node" });
  for (const edge of graph.edges) {
    if (!nodes.has(edge.fromNodeKey) || !nodes.has(edge.toNodeKey) || partitions.get(edge.partitionKey)?.nodeKey !== edge.fromNodeKey) ctx.addIssue({ code: "custom", path: ["edges"], message: "Invalid edge target or partition" });
    if (edge.basis.kind === "selected-observation" && edge.weight !== null) ctx.addIssue({ code: "custom", path: ["edges"], message: "Selected observations have no admitted denominator" });
    if (edge.basis.kind === "serial-claim" && edge.weight !== null && (!edge.basis.entireClaim || edge.weight !== 1)) ctx.addIssue({ code: "custom", path: ["edges"], message: "Quantified serial claims require a verified entire unit claim" });
    if (edge.basis.kind === "reserve-position" && edge.kind !== "reserve-position") ctx.addIssue({ code: "custom", path: ["edges"], message: "Reserve joins require reserve-position edges" });
  }
  for (const row of [...graph.authorities, ...graph.partitions, ...graph.unresolved]) if (!nodes.has(row.nodeKey)) ctx.addIssue({ code: "custom", message: "Unknown graph node" });
  for (const authority of graph.authorities) {
    const node = graph.nodes.find((candidate) => candidate.nodeKey === authority.nodeKey);
    if (node?.noCurrentReach && node.status.observationState === "known" && authority.reach === "current" && authority.status.observationState === "known" &&
      authority.actingDeployment.chainId === node.identity.chainId && authority.actingDeployment.claimAddress === node.identity.claimAddress) {
      ctx.addIssue({ code: "custom", path: ["authorities"], message: "Current authority contradicts reviewed no-current-reach coverage" });
    }
  }
});
const PathSchema = z.object({ edgeKeys: z.array(CanonicalTextSchema), positionKeys: z.array(CanonicalTextSchema), knownReachShare: FractionSchema.nullable() }).strict();
export const V9AccessLookthroughSummarySchema = z.object({
  diagnosticOnly: z.literal(true), coverageState: V9AccessCoverageStateSchema,
  knownAdverseReachShare: FractionSchema.nullable(), reviewedNoCurrentReachShare: FractionSchema.nullable(), unresolvedCoverageShare: FractionSchema.nullable(),
  authorities: canonicalArrayBy(z.object({ ...AuthorityShape, knownReachShare: FractionSchema.nullable(), unresolvedReachShare: FractionSchema.nullable(), paths: z.array(PathSchema) }).strict(), (v) => v.authorityKey),
  unresolved: canonicalArrayBy(z.object({ ...UnresolvedShape }).strict(), (v) => v.branchKey),
  evidenceRefIds: canonicalTextArray(),
}).strict().superRefine((summary, ctx) => {
  const shares = [summary.knownAdverseReachShare, summary.reviewedNoCurrentReachShare, summary.unresolvedCoverageShare];
  if (shares.some((s) => s === null) && !shares.every((s) => s === null)) ctx.addIssue({ code: "custom", message: "Aggregate fractions share one admitted denominator" });
  if (shares.every((s) => s !== null) && Math.abs((shares as number[]).reduce((a, b) => a + b, 0) - 1) > 1e-8) ctx.addIssue({ code: "custom", message: "Access union must reconcile to one" });
  if (summary.coverageState === "complete" && (shares.some((s) => s === null) || summary.unresolvedCoverageShare !== 0 || summary.unresolved.length > 0)) ctx.addIssue({ code: "custom", message: "Complete access requires priced, fully reviewed coverage" });
  for (const authority of summary.authorities) {
    if (summary.knownAdverseReachShare === null && (authority.knownReachShare !== null || authority.unresolvedReachShare !== null || authority.paths.some((path) => path.knownReachShare !== null))) ctx.addIssue({ code: "custom", message: "Unpriced authority and path fractions must remain null" });
    if (authority.reach !== "current" && authority.knownReachShare !== null) ctx.addIssue({ code: "custom", message: "Possible reach is not quantified known reach" });
    if (authority.knownReachShare !== null && summary.knownAdverseReachShare !== null && authority.knownReachShare > summary.knownAdverseReachShare + 1e-8) ctx.addIssue({ code: "custom", message: "Originating authority reach cannot exceed the adverse union" });
  }
});
export type V9AccessClaimGraph = z.output<typeof V9AccessClaimGraphSchema>;
export type V9AccessClaimGraphReview = z.output<typeof V9AccessClaimGraphReviewSchema>;
export type V9AccessLookthroughSummary = z.output<typeof V9AccessLookthroughSummarySchema>;
export type V9AccessLookthroughOverlay = z.output<typeof V9AccessLookthroughOverlaySchema>;
export type V9AccessClaimNode = V9AccessClaimGraph["nodes"][number];
export type V9AccessClaimEdge = V9AccessClaimGraph["edges"][number];
export type V9AccessOriginatingAuthority = V9AccessClaimGraph["authorities"][number];
export type V9AccessClaimPartition = V9AccessClaimGraph["partitions"][number];
export type V9AccessUnresolvedBranch = V9AccessClaimGraph["unresolved"][number];
export type V9AccessUnresolvedReason = z.output<typeof V9AccessUnresolvedReasonSchema>;
export function v9AccessClaimGraphStatuses(graph: V9AccessClaimGraph | null | undefined) {
  if (!graph) return [];
  return [...graph.nodes.map((n) => ({ label: `access:graph:node:${n.nodeKey}`, status: n.status })),
    ...graph.edges.map((e) => ({ label: `access:graph:edge:${e.edgeKey}`, status: e.status })),
    ...graph.authorities.map((a) => ({ label: `access:graph:authority:${a.authorityKey}`, status: a.status })),
    ...graph.partitions.map((p) => ({ label: `access:graph:partition:${p.partitionKey}`, status: p.status })),
    ...graph.unresolved.map((u) => ({ label: `access:graph:unresolved:${u.branchKey}`, status: u.status }))];
}
