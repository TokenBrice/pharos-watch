import { z } from "zod";
import { V9DependencyEconomicRoleSchema } from "./dependency-types";
import {
  ReportCardsV9DependencyGraphSchema,
  V9PublicationHealthSchema,
  type ReportCardsV9CurrentResponse,
} from "./report-cards-v9";
import { V9GradeSchema } from "./safety-score-v9";
import { SafetyScoreV9CommonModeGroupsSchema } from "./safety-score-v9-public";
import { SafetyScoreV9CapSchema, isUniqueSorted } from "./safety-score-v9-public-facts";
import { SafetyScoreV9ScoreTraceSchema } from "./safety-score-v9-public-trace";

export const DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION = 1;

export const DependencyGraphNodeSchema = z.object({
  id: z.string().min(1),
  grade: V9GradeSchema,
  score: z.number().finite().min(0).max(100).nullable(),
  circulatingUsdAtEvaluation: z.number().finite().nonnegative().nullable(),
  supplyAsOfSec: z.number().int().nonnegative().nullable(),
  sharedBookId: z.string().min(1).nullable(),
  roles: z.array(z.object({
    upstreamAssetId: z.string().min(1),
    economicRole: V9DependencyEconomicRoleSchema,
    weight: z.number().finite().min(0).max(1),
  }).strict()),
  dependencyCoverageCount: z.number().int().nonnegative().nullable(),
}).strict();
export type DependencyGraphNode = z.infer<typeof DependencyGraphNodeSchema>;

export const DependencyGraphResolvedCapSchema = SafetyScoreV9CapSchema.pick({
  kind: true,
  limit: true,
  binding: true,
});
const deploymentAdjustmentShape = SafetyScoreV9ScoreTraceSchema.shape.deploymentRisk.shape.adjustments.element.shape;
export const DependencyGraphResolvedAdjustmentSchema = z.object({
  scoreBefore: deploymentAdjustmentShape.scoreBefore,
  scoreAfter: deploymentAdjustmentShape.scoreAfter,
  adjustmentPoints: deploymentAdjustmentShape.adjustmentPoints,
}).strict();
const publishedGroupSchema = SafetyScoreV9CommonModeGroupsSchema.element;
export const DependencyGraphPricedEffectSchema = publishedGroupSchema.shape.pricedEffects.unwrap().element.extend({
  resolvedCaps: z.array(DependencyGraphResolvedCapSchema),
  resolvedAdjustments: z.array(DependencyGraphResolvedAdjustmentSchema),
  referencesUnresolved: z.literal(true).optional(),
});
export const DependencyGraphCommonModeGroupSchema = publishedGroupSchema.safeExtend({
  pricedEffects: z.array(DependencyGraphPricedEffectSchema).min(1).optional(),
});
export const DependencyGraphCommonModeGroupsSchema = z.array(DependencyGraphCommonModeGroupSchema).superRefine((groups, ctx) => {
  if (!isUniqueSorted(groups.map((group) => group.id))) {
    ctx.addIssue({ code: "custom", message: "Common-mode groups must have unique, sorted IDs" });
  }
});

export const DependencyGraphResponseSchema = ReportCardsV9DependencyGraphSchema.safeExtend({
  model: z.literal("v9"),
  schemaVersion: z.literal(DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION),
  methodologyVersion: z.string().trim().min(1),
  publicationGenerationId: z.string().min(1),
  asOfSec: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  publicationStatus: z.enum(["current", "held"]),
  // Preserve hold reasons and the hold clock for the map's existing status notice.
  publicationHealth: V9PublicationHealthSchema,
  nodes: z.array(DependencyGraphNodeSchema),
  commonModeGroups: DependencyGraphCommonModeGroupsSchema.optional(),
}).strict().superRefine((response, ctx) => {
  response.nodes.forEach((node, index) => {
    if (index > 0 && response.nodes[index - 1]!.id >= node.id) {
      ctx.addIssue({ code: "custom", path: ["nodes", index], message: "Dependency nodes must be unique and sorted by id" });
    }
  });
  if (response.publicationStatus !== response.publicationHealth.status ||
      response.publicationGenerationId !== response.publicationHealth.acceptedPublicationGenerationId) {
    ctx.addIssue({ code: "custom", path: ["publicationHealth"], message: "Dependency graph health must identify its accepted publication and status" });
  }
});
export type DependencyGraphResponse = z.infer<typeof DependencyGraphResponseSchema>;

function resolveCommonModeEffects(snapshot: ReportCardsV9CurrentResponse): z.infer<typeof DependencyGraphCommonModeGroupsSchema> | undefined {
  if (snapshot.commonModeGroups === undefined) return undefined;
  let cardsById: Map<string, ReportCardsV9CurrentResponse["cards"][number]> | undefined;
  return snapshot.commonModeGroups.map(({ pricedEffects, ...group }) => {
    if (pricedEffects === undefined) return group;
    cardsById ??= new Map(snapshot.cards.map((card) => [card.id, card]));
    return {
      ...group,
      pricedEffects: pricedEffects.map((effect) => {
        const card = cardsById!.get(effect.assetId);
        const resolvedCaps: z.infer<typeof DependencyGraphResolvedCapSchema>[] = [];
        const resolvedAdjustments: z.infer<typeof DependencyGraphResolvedAdjustmentSchema>[] = [];
        let referencesUnresolved = false;
        for (const index of effect.capIndices) {
          const cap = card?.caps[index];
          if (cap === undefined) referencesUnresolved = true;
          else resolvedCaps.push({ kind: cap.kind, limit: cap.limit, binding: cap.binding });
        }
        for (const index of effect.deploymentAdjustmentIndices) {
          const adjustment = card?.scoreTrace.deploymentRisk.adjustments[index];
          if (adjustment === undefined) referencesUnresolved = true;
          else resolvedAdjustments.push({
            scoreBefore: adjustment.scoreBefore,
            scoreAfter: adjustment.scoreAfter,
            adjustmentPoints: adjustment.adjustmentPoints,
          });
        }
        return {
          ...effect,
          resolvedCaps,
          resolvedAdjustments,
          ...(referencesUnresolved ? { referencesUnresolved: true as const } : {}),
        };
      }),
    };
  });
}

/** Project only the accepted publication; no live supply or recomputed edges. */
export function projectDependencyGraph(snapshot: ReportCardsV9CurrentResponse): DependencyGraphResponse {
  const commonModeGroups = resolveCommonModeEffects(snapshot);
  return {
    model: "v9",
    schemaVersion: DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION,
    methodologyVersion: snapshot.methodology.version,
    publicationGenerationId: snapshot.safetyScoreIdentity.publicationGenerationId,
    asOfSec: snapshot.asOfSec,
    updatedAt: snapshot.updatedAt,
    publicationStatus: snapshot.publicationHealth.status,
    publicationHealth: snapshot.publicationHealth,
    nodes: snapshot.cards.map((card) => ({
      id: card.id,
      grade: card.grade,
      score: card.score,
      circulatingUsdAtEvaluation: card.supply?.circulatingUsdAtEvaluation ?? null,
      supplyAsOfSec: card.supply?.asOfSec ?? null,
      sharedBookId: card.sharedBookId ?? null,
      roles: (card.dependencies.roles ?? []).map((role) => ({
        upstreamAssetId: role.upstreamAssetId,
        economicRole: role.role,
        weight: role.weight,
      })),
      dependencyCoverageCount: card.dependencyCoverage?.length ?? null,
    })),
    edges: snapshot.dependencyGraph.edges,
    ...(commonModeGroups === undefined ? {} : { commonModeGroups }),
  };
}
