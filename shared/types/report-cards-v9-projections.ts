import { z } from "zod";
import { ReportCardsV9CurrentResponseSchema, ReportCardsV9DependencyGraphSchema } from "./report-cards-v9";
import { SafetyScoreV9CurrentCardBaseSchema, SafetyScoreV9ResolvedCurrentCardSchema } from "./safety-score-v9-public";
import type { ReportCardsV9CurrentResponse } from "./report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "./safety-score-v9-public";
import { refineV9RatingStatusFields, V9CompactPartialEvidenceSchema } from "./safety-score-v9-causes";
import { DependencyGraphResponseSchema } from "./dependency-graph";

export type ReportCardsV9ProjectionSource = Omit<ReportCardsV9CurrentResponse, "cards"> & { cards: SafetyScoreV9CurrentCard[] };

export const V9_SITE_PROJECTION_VERSION = 1;
const card = SafetyScoreV9CurrentCardBaseSchema.shape;
const envelope = ReportCardsV9CurrentResponseSchema.shape;
const common = {
  projectionVersion: z.literal(V9_SITE_PROJECTION_VERSION),
  model: envelope.model, lifecycle: envelope.lifecycle, schemaVersion: envelope.schemaVersion,
  safetyScoreIdentity: envelope.safetyScoreIdentity, methodology: envelope.methodology,
  asOfSec: envelope.asOfSec, updatedAt: envelope.updatedAt, source: envelope.source,
  completeness: envelope.completeness, publicationHealth: envelope.publicationHealth,
};
const tablePillar = z.object({
  score: card.pillars.shape.backing.shape.score,
  aggregationDisposition: card.pillars.shape.backing.shape.aggregationDisposition,
}).strict();

/** Only fields consumed by cross-asset tables, filters, exports and mini radars. */
export const ReportCardsV9TableCardSchema = z.object({
  id: card.id, score: card.score, grade: card.grade, ratingStatus: card.ratingStatus,
  partialEvidence: V9CompactPartialEvidenceSchema.nullable(),
  pillars: z.object({ backing: tablePillar, exit: tablePillar, control: tablePillar }).strict(),
  evidence: z.object({ level: card.evidence.shape.level }).strict(),
  weakestPillar: card.weakestPillar, bindingCap: card.bindingCap,
  accessPosture: z.object({ freezeExposure: card.accessPosture.shape.freezeExposure }).strict(),
  nrReasons: card.nrReasons, reasonCodes: card.reasonCodes,
  mint: z.object({ score: z.number().finite().min(0).max(100), posture: z.string().nullable() }).strict().nullable(),
}).strict().superRefine(refineV9RatingStatusFields);
export type ReportCardsV9TableCard = z.infer<typeof ReportCardsV9TableCardSchema>;

function refineEnvelope(value: z.infer<z.ZodObject<typeof common>>, ctx: z.RefinementCtx) {
  const identity = value.safetyScoreIdentity;
  if (identity.methodologyVersion !== value.methodology.version || identity.policyId !== value.methodology.policy.id ||
      identity.policyDigest !== value.methodology.policy.semanticDigest || value.asOfSec > value.updatedAt) {
    ctx.addIssue({ code: "custom", message: "Projection identity, methodology or clocks disagree" });
  }
}
export const ReportCardsV9TableResponseSchema = z.object({
  ...common, projection: z.literal("table"), cards: z.array(ReportCardsV9TableCardSchema),
  dependencyGraph: ReportCardsV9DependencyGraphSchema,
}).strict().superRefine((value, ctx) => {
  refineEnvelope(value, ctx);
  const ids = value.cards.map(row => row.id);
  if (ids.length !== value.completeness.expectedCount || !ids.every((id, i) => i === 0 || ids[i - 1]! < id) ||
      JSON.stringify(value.cards.filter(row => row.ratingStatus === "not-rated").map(row => row.id)) !== JSON.stringify(value.completeness.notRatedIds) ||
      JSON.stringify(value.cards.filter(row => row.ratingStatus === "pipeline-gap").map(row => row.id)) !== JSON.stringify(value.completeness.pipelineGapIds) ||
      value.cards.filter(row => row.ratingStatus === "rated").length !== value.completeness.ratedCount) {
    ctx.addIssue({ code: "custom", message: "Table must preserve the entire disjoint publication census" });
  }
  const members = new Set(ids);
  if (value.dependencyGraph.edges.some(edge => !members.has(edge.from) || !members.has(edge.to))) {
    ctx.addIssue({ code: "custom", message: "Table graph references an absent asset" });
  }
});
export type ReportCardsV9TableResponse = z.infer<typeof ReportCardsV9TableResponseSchema>;

export const ReportCardsV9NeighborhoodCardSchema = z.object({
  id: card.id, grade: card.grade, partialEvidence: V9CompactPartialEvidenceSchema.nullable(), sharedBookId: card.sharedBookId,
}).strict();
export type ReportCardsV9NeighborhoodCard = z.infer<typeof ReportCardsV9NeighborhoodCardSchema>;
export const ReportCardsV9DetailResponseSchema = z.object({
  ...common, projection: z.literal("detail"), coinId: z.string().min(1),
  cards: z.array(SafetyScoreV9ResolvedCurrentCardSchema).length(1),
  neighborhood: z.array(ReportCardsV9NeighborhoodCardSchema),
  dependencyGraph: ReportCardsV9DependencyGraphSchema,
  commonModeGroups: DependencyGraphResponseSchema.shape.commonModeGroups,
  // Global indices are preserved verbatim; no compact table can rebind a numeric gap reference.
  foreignCauseGaps: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/u), z.string().min(1)),
  scope: z.object({
    kind: z.literal("incident-and-dependent-input-closure"),
    returnedCount: z.number().int().positive(), expectedCount: z.number().int().positive(),
    returnedEdgeCount: z.number().int().nonnegative(), totalEdgeCount: z.number().int().nonnegative(),
    totalForeignGapCount: z.number().int().nonnegative(),
    complete: z.literal(true),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  refineEnvelope(value, ctx);
  const ids = value.neighborhood.map(row => row.id);
  const members = new Set(ids);
  const refs = value.cards[0]?.foreignCauseGapRefs ?? [];
  if (Object.keys(value.foreignCauseGaps).length !== refs.length ||
      refs.some(ref => ref >= value.scope.totalForeignGapCount || value.foreignCauseGaps[String(ref)] === undefined)) {
    ctx.addIssue({ code: "custom", message: "Detail foreign gap context must preserve every original referenced index" });
  }
  if (value.cards[0]?.id !== value.coinId || !members.has(value.coinId) ||
      ids.length !== value.scope.returnedCount || value.scope.expectedCount !== value.completeness.expectedCount ||
      value.scope.returnedCount > value.scope.expectedCount || !ids.every((id, i) => i === 0 || ids[i - 1]! < id) ||
      value.scope.returnedEdgeCount !== value.dependencyGraph.edges.length || value.scope.returnedEdgeCount > value.scope.totalEdgeCount ||
      value.dependencyGraph.edges.some(edge => !members.has(edge.from) || !members.has(edge.to)) ||
      value.commonModeGroups?.some(group => !group.memberAssetIds.includes(value.coinId) || group.memberAssetIds.some(id => !members.has(id)))) {
    ctx.addIssue({ code: "custom", message: "Detail scope, selected card and neighborhood do not reconcile" });
  }
});
export type ReportCardsV9DetailResponse = z.infer<typeof ReportCardsV9DetailResponseSchema>;
