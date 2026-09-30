import { z } from "zod";
import { V9DependencyEconomicRoleSchema } from "./dependency-types";
import {
  ReportCardsV9DependencyGraphSchema,
  V9PublicationHealthSchema,
  type ReportCardsV9CurrentResponse,
} from "./report-cards-v9";
import { V9GradeSchema } from "./safety-score-v9";
import { SafetyScoreV9CommonModeGroupsSchema } from "./safety-score-v9-public";

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
  commonModeGroups: SafetyScoreV9CommonModeGroupsSchema.optional(),
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

/** Project only the accepted publication; no live supply or recomputed edges. */
export function projectDependencyGraph(snapshot: ReportCardsV9CurrentResponse): DependencyGraphResponse {
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
    ...(snapshot.commonModeGroups === undefined ? {} : { commonModeGroups: snapshot.commonModeGroups }),
  };
}
