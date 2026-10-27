import { z } from "zod";
import { ReportCardsV9DependencyGraphSchema } from "./report-cards-v9";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import { SafetyScoreV9CurrentCardSchema, SafetyScoreV9CommonModeGroupsSchema } from "./safety-score-v9-public";
import { V9CompactPartialEvidenceSchema } from "./safety-score-v9-causes";
import { Sha256Schema, UnixSecondsSchema, issue } from "./safety-schema-primitives";

export const SAFETY_SCORE_COHORT_MAX_BYTES = 4 * 1024 * 1024;

export const SafetyScoreCohortStorageEnvelopeSchema = z.strictObject({
  payloadSha256: Sha256Schema,
  payloadChunks: z.strictObject({
    count: z.number().int().min(1).max(9),
    payloadBytes: z.number().int().min(1).max(SAFETY_SCORE_COHORT_MAX_BYTES),
    payloadSha256: Sha256Schema,
    storedBytes: z.number().int().min(1).max(SAFETY_SCORE_COHORT_MAX_BYTES),
  }),
});

const card = SafetyScoreV9CurrentCardSchema.shape;
const pillar = card.pillars.shape.backing.shape;
const reason = pillar.reasons.element.shape;
const CohortPillarSchema = z.strictObject({
  score: pillar.score, aggregationDisposition: pillar.aggregationDisposition,
  evidenceLevel: pillar.evidenceLevel, freshness: pillar.freshness,
  reasons: z.array(z.strictObject({ code: reason.code, message: reason.message })),
});
const cap = card.caps.element.shape;
const CohortCapSchema = z.strictObject({ kind: cap.kind, limit: cap.limit, reason: cap.reason, binding: cap.binding });
const trace = card.scoreTrace.shape;
const adjustment = trace.deploymentRisk.shape.adjustments.element.shape;
const exit = card.breakdowns.unwrap().shape.exit.shape;
const primaryRoute = exit.primaryRoute.unwrap().shape;
const role = card.dependencies.shape.roles.unwrap().element.shape;
const controlComponent = card.breakdowns.unwrap().shape.control.shape.components.element;
const SafetyScoreCohortCardBaseSchema = z.strictObject({
  id: card.id, score: card.score, grade: card.grade,
  ratingStatus: card.ratingStatus, partialEvidence: V9CompactPartialEvidenceSchema.nullable(),
  sharedBookId: card.sharedBookId,
  supply: card.supply.unwrap().pick({ circulatingUsdAtEvaluation: true, asOfSec: true }).optional(),
  dependencyCoverage: z.strictObject({ length: z.number().int().nonnegative() }).optional(),
  pillars: z.strictObject({ backing: CohortPillarSchema, exit: CohortPillarSchema, control: CohortPillarSchema }),
  caps: z.array(CohortCapSchema), bindingCap: CohortCapSchema.nullable(), reasonCodes: card.reasonCodes,
  scoreTrace: z.strictObject({
    aggregation: z.strictObject({ pricedUnknownPillars: trace.aggregation.unwrap().shape.pricedUnknownPillars }).nullable(),
    deploymentRisk: z.strictObject({ adjustments: z.array(z.strictObject({
      scoreBefore: adjustment.scoreBefore, scoreAfter: adjustment.scoreAfter, adjustmentPoints: adjustment.adjustmentPoints,
    })) }),
  }),
  dependencies: z.strictObject({
    roles: z.array(z.strictObject({ upstreamAssetId: role.upstreamAssetId, role: role.role, weight: role.weight })).optional(),
    serial: z.array(z.strictObject({ upstreamAssetId: card.dependencies.shape.serial.element.shape.upstreamAssetId })),
  }),
  breakdowns: z.strictObject({
    exit: z.strictObject({ stressRequest: exit.stressRequest,
      primaryRoute: z.strictObject({ key: primaryRoute.key, score: primaryRoute.score, capacity: primaryRoute.capacity }).nullable(),
    }),
    control: z.strictObject({
      components: z.array(z.strictObject({ kind: controlComponent.shape.kind, posture: controlComponent.shape.posture })),
    }),
  }).nullable(),
});
export type SafetyScoreCohortCard = z.infer<typeof SafetyScoreCohortCardBaseSchema>;

// Grade fields come from the bound index; graph edges and binding caps already retain these facts.
const SafetyScoreCohortStoredCardSchema = SafetyScoreCohortCardBaseSchema.omit({
  score: true, grade: true, ratingStatus: true, partialEvidence: true, bindingCap: true,
}).extend({
  dependencies: SafetyScoreCohortCardBaseSchema.shape.dependencies.omit({ serial: true }),
});
export type SafetyScoreCohortStoredCard = z.infer<typeof SafetyScoreCohortStoredCardSchema>;

/** Accepted read model only; scores and graph come from the admitted publication. */
export const SafetyScoreCohortSchema = z.strictObject({
  schemaVersion: z.literal(1),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  publicationResultDigest: Sha256Schema,
  asOfSec: UnixSecondsSchema,
  publishedAtSec: UnixSecondsSchema,
  dependencyGraph: ReportCardsV9DependencyGraphSchema,
  commonModeGroups: SafetyScoreV9CommonModeGroupsSchema.optional(),
  cards: z.array(SafetyScoreCohortStoredCardSchema),
}).superRefine((value, ctx) => {
  if (value.asOfSec > value.publishedAtSec) issue(ctx, ["asOfSec"], "Projection source clock must not postdate publication");
  const ids = value.cards.map((entry) => entry.id);
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    issue(ctx, ["cards"], "Cohort cards must be uniquely sorted");
  }
});
export type SafetyScoreCohort = z.infer<typeof SafetyScoreCohortSchema>;
