import { z } from "zod";
import { ContagionScenarioSchema } from "./contagion";
import { V9GradeSchema } from "./safety-score-v9";
import { BaseInputGenerationIdSchema, Sha256Schema, ScoreSchema, UnixSecondsSchema } from "./safety-schema-primitives";

export const DEPENDENCY_SCENARIOS_INTERVAL_MS = 3_600_000;
export const DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC = 7_200;
export const DEPENDENCY_SCENARIOS_CACHE_PREFIX = "dependency-scenarios:v1:";
export const DependencyScenarioArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  sourcePublicationGenerationId: z.string().min(1),
  sourceBaseInputGenerationId: BaseInputGenerationIdSchema,
  methodologyVersion: z.string().min(1),
  evaluationBuildDigest: Sha256Schema,
  computedAtSec: UnixSecondsSchema,
  cohort: z.object({ rootIds: z.array(z.string().min(1)).max(15), selection: z.string().min(1) }).strict(),
  scenarios: z.array(z.object({
    id: z.string().min(1), rootId: z.string().min(1),
    shock: ContagionScenarioSchema.shape.shocks.element,
    assumptions: z.array(z.string().min(1)),
    results: z.array(z.object({
      assetId: z.string().min(1),
      publishedScore: ScoreSchema.nullable(), publishedGrade: V9GradeSchema,
      modeledScore: ScoreSchema.nullable(), modeledGrade: V9GradeSchema,
      deltaScore: z.number().finite().min(-100).max(100).nullable(),
      minHop: z.number().int().nonnegative().nullable(), roles: z.array(z.string().min(1)),
    }).strict()),
    failures: z.array(z.object({ assetId: z.string().min(1), code: z.string().min(1) }).strict()),
  }).strict()).max(45),
}).strict().superRefine((artifact, ctx) => {
  const roots = new Set(artifact.cohort.rootIds);
  if (roots.size !== artifact.cohort.rootIds.length) ctx.addIssue({ code: "custom", message: "Duplicate cohort roots" });
  const ids = new Set<string>();
  for (const scenario of artifact.scenarios) {
    if (ids.has(scenario.id) || !roots.has(scenario.rootId) || scenario.shock.assetId !== scenario.rootId) {
      ctx.addIssue({ code: "custom", message: "Scenario identity must match a unique cohort root shock" });
    }
    ids.add(scenario.id);
    const assets = new Set<string>();
    for (const row of scenario.results) {
      if (assets.has(row.assetId)) ctx.addIssue({ code: "custom", message: "Duplicate result asset" });
      assets.add(row.assetId);
      const delta = row.publishedScore === null || row.modeledScore === null ? null : row.modeledScore - row.publishedScore;
      if (delta !== row.deltaScore || (row.modeledGrade === "NR") !== (row.modeledScore === null) ||
          (row.publishedGrade === "NR") !== (row.publishedScore === null)) {
        ctx.addIssue({ code: "custom", message: "Result score, grade and delta disagree" });
      }
    }
    if (!assets.has(scenario.rootId)) ctx.addIssue({ code: "custom", message: "Scenario root row is required" });
  }
});
export type DependencyScenarioArtifact = z.output<typeof DependencyScenarioArtifactSchema>;
export const DependencyScenariosResponseSchema = z.object({
  artifact: DependencyScenarioArtifactSchema.nullable(),
  freshness: z.object({
    status: z.enum(["current", "earlier-generation", "stale", "unavailable"]),
    reason: z.string().min(1).nullable(), ageSec: z.number().int().nonnegative().nullable(),
    budgetSec: z.literal(DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC),
    sourcePublicationGenerationId: z.string().min(1).nullable(),
    acceptedPublicationGenerationId: z.string().min(1).nullable(),
  }).strict(),
}).strict().superRefine(({ artifact, freshness }, ctx) => {
  const source = artifact?.sourcePublicationGenerationId ?? null;
  const readable = freshness.status === "current" || freshness.status === "earlier-generation";
  const sameGeneration = source !== null && source === freshness.acceptedPublicationGenerationId;
  if (freshness.sourcePublicationGenerationId !== source ||
      (freshness.status === "current" ? freshness.reason !== null : freshness.reason === null) ||
      (readable && (!artifact || freshness.acceptedPublicationGenerationId === null ||
        freshness.ageSec === null || freshness.ageSec > freshness.budgetSec)) ||
      (freshness.status === "current" && !sameGeneration) ||
      (freshness.status === "earlier-generation" && sameGeneration) ||
      (freshness.status === "stale" && (!artifact || freshness.ageSec === null || freshness.ageSec <= freshness.budgetSec))) {
    ctx.addIssue({ code: "custom", path: ["freshness"], message: "Freshness must name the artifact generation and its budget honestly" });
  }
});
export type DependencyScenariosResponse = z.output<typeof DependencyScenariosResponseSchema>;

export function dependencyScenarioFreshness(artifact: DependencyScenarioArtifact | null, acceptedGeneration: string | null, nowSec: number): DependencyScenariosResponse["freshness"] {
  const ageSec = artifact ? Math.max(0, nowSec - artifact.computedAtSec) : null;
  const provenance = {
    ageSec, budgetSec: DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC,
    sourcePublicationGenerationId: artifact?.sourcePublicationGenerationId ?? null,
    acceptedPublicationGenerationId: acceptedGeneration,
  } as const;
  if (!artifact) return { ...provenance, status: "unavailable", reason: "artifact-unavailable" };
  if (!acceptedGeneration) return { ...provenance, status: "unavailable", reason: "accepted-publication-unavailable" };
  if (artifact.computedAtSec > nowSec) return { ...provenance, status: "unavailable", reason: "artifact-clock-in-future" };
  if (ageSec! > DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC) return { ...provenance, status: "stale", reason: "artifact-outside-freshness-budget" };
  if (artifact.sourcePublicationGenerationId !== acceptedGeneration) return { ...provenance, status: "earlier-generation", reason: "source-generation-mismatch" };
  return { ...provenance, status: "current", reason: null };
}
