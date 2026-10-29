import { z } from "zod";
import { issue } from "./safety-schema-primitives";
import {
  SafetyScoreV9CompletenessSchema,
  SafetyScoreV9CommonModeGroupsSchema,
  SafetyScoreV9CurrentCardSchema,
  findSafetyScoreV9ParentAttributionIssues,
  type SafetyScoreV9CurrentCard,
} from "./safety-score-v9-public";
import {
  BaseInputGenerationIdSchema,
  SafetyScoreV9PillarFreshnessSchema,
  Sha256Schema,
  V9PolicyVersionSchema,
  isUniqueSorted,
  refineSafetyScoreV9PillarFreshness,
} from "./safety-score-v9-public-facts";
import {
  V9OpenEvidenceSchema,
  type V9OpenEvidence,
} from "./safety-score-v9-open-evidence";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
import { refineV9PublicGapContext } from "./safety-score-v9-public-causes";

/**
 * The internal publication envelope. Split out of `safety-score-v9-public.ts`
 * (a module browser readers import for the card schemas) so the schema-8
 * envelope's OpenEvidence validator stays on the worker/script side.
 */
export const SafetyScoreV9ResponseShape = {
  model: z.literal("v9-critical-path"),
  lifecycle: z.literal("active"),
  candidateId: z.string().min(1),
  policyVersion: V9PolicyVersionSchema,
  publicationGenerationId: z.string().min(1),
  baseInputGenerationId: BaseInputGenerationIdSchema,
  factSetDigest: Sha256Schema,
  resultDigest: Sha256Schema,
  policy: z.object({ id: z.string().min(1), semanticDigest: Sha256Schema }).strict(),
  evaluationBuildDigest: Sha256Schema,
  sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
  asOfSec: z.number().int().nonnegative(),
  publishedAtSec: z.number().int().nonnegative(),
  completeness: SafetyScoreV9CompletenessSchema,
  foreignCauseGaps: canonicalTextArray(),
  commonModeGroups: SafetyScoreV9CommonModeGroupsSchema.optional(),
  pillarFreshness: SafetyScoreV9PillarFreshnessSchema.optional(),
} as const;

function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CurrentCard[];
    foreignCauseGaps: readonly string[];
    sourceGenerations: Readonly<Record<string, string>>;
    pillarFreshness?: z.infer<typeof SafetyScoreV9PillarFreshnessSchema>;
    documentationCauseGaps?: readonly string[];
    openEvidence?: V9OpenEvidence;
  },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  refineV9PublicGapContext(response, ctx);
  refineSafetyScoreV9PillarFreshness(response, ctx);
  if (response.publishedAtSec < response.asOfSec) {
    ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Publication cannot predate evidence" });
  }
  if (response.cards.length !== response.completeness.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card set is not complete" });
  }
  const ids = response.cards.map((card) => card.id);
  if (!isUniqueSorted(ids)) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card IDs must be unique and sorted" });
  }
  const notRatedIds = response.cards.filter((card) => card.grade === "NR").map((card) => card.id);
  if (JSON.stringify(notRatedIds) !== JSON.stringify(response.completeness.notRatedIds)) {
    ctx.addIssue({ code: "custom", path: ["completeness"], message: "V9 NR membership does not reconcile" });
  }
  const pipelineGapIds = response.cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
  if (JSON.stringify(pipelineGapIds) !== JSON.stringify(response.completeness.pipelineGapIds) ||
      response.cards.filter((card) => card.ratingStatus === "rated").length !== response.completeness.ratedCount) {
    ctx.addIssue({ code: "custom", path: ["completeness"], message: "V9 rated and pipeline-gap membership does not reconcile" });
  }
  for (const finding of findSafetyScoreV9ParentAttributionIssues(response)) {
    issue(ctx, ["cards"], `${finding.cardId}: ${finding.message}`);
  }
  const cardsById = new Map(response.cards.map((card) => [card.id, card]));
  const documentationCauseGaps = response.documentationCauseGaps;
  if (documentationCauseGaps !== undefined) {
    const resolvable = new Set(response.foreignCauseGaps);
    for (const card of response.cards) {
      for (const gapId of card.localCauseGaps) resolvable.add(`${card.id}:gap:${gapId}`);
    }
    documentationCauseGaps.forEach((gapId, index) => {
      if (!resolvable.has(gapId)) {
        issue(ctx, ["documentationCauseGaps", index], "Documentation cause gaps must resolve to a published card or foreign gap");
      }
    });
  }
  if (response.openEvidence !== undefined) {
    if (documentationCauseGaps === undefined && response.openEvidence.documentation.datums > 0) {
      issue(ctx, ["documentationCauseGaps"], "Documentation datums require the publication documentation gap set");
    }
    if (response.openEvidence.issuer.newestReviewedAtSec !== null &&
        response.openEvidence.issuer.newestReviewedAtSec > response.publishedAtSec) {
      issue(ctx, ["openEvidence", "issuer", "newestReviewedAtSec"], "Issuer review proofs cannot postdate the publication");
    }
    response.openEvidence.byCard.forEach((entry, index) => {
      const card = cardsById.get(entry.id);
      if (card === undefined) {
        issue(ctx, ["openEvidence", "byCard", index, "id"], "Open-evidence counts must name a published card");
        return;
      }
      if (entry.issuerNondisclosureReviewedAtSec !== undefined &&
          entry.issuerNondisclosureReviewedAtSec > response.publishedAtSec) {
        issue(ctx, ["openEvidence", "byCard", index, "issuerNondisclosureReviewedAtSec"],
          "Issuer review proofs cannot postdate the publication");
      }
      const annotated = entry.documentationOnlyLimited;
      if (annotated !== undefined) {
        for (let pillarIndex = 0; pillarIndex < annotated.length; pillarIndex++) {
          const pillar = annotated[pillarIndex]!;
          const pillarRow = card.pillars[pillar];
          if (documentationCauseGaps === undefined) {
            issue(ctx, ["openEvidence", "byCard", index, "documentationOnlyLimited", pillarIndex],
              "A documentation-only pillar annotation requires the documentation gap set");
          }
          if (pillarRow.evidenceLevel !== "limited" || (pillarRow.limitedEvidenceCauses?.length ?? 0) === 0) {
            issue(ctx, ["openEvidence", "byCard", index, "documentationOnlyLimited", pillarIndex],
              "Only a limited pillar with witnesses can be documented as documentation-only limited");
          }
        }
      }
    });
  }
}

/** Previous schema-7 envelope: admitted by the publication codec only during the v7→v8 cutover. */
export const SafetyScoreV9PreviousResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(7),
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9PreviousResponse = z.infer<typeof SafetyScoreV9PreviousResponseSchema>;

/** Current schema-8 envelope: every live publication carries the open-evidence block. */
export const SafetyScoreV9CurrentResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(8),
    openEvidence: V9OpenEvidenceSchema,
    /** T2 carrier: the publication union of documentation-classified cause gaps. */
    documentationCauseGaps: canonicalTextArray().optional(),
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9CurrentResponse = z.infer<typeof SafetyScoreV9CurrentResponseSchema>;

export const SafetyScoreV9ResponseSchema = SafetyScoreV9CurrentResponseSchema;
