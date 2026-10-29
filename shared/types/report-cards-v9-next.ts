import { z } from "zod";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
import { SafetyScoreV9ResolvedCurrentCardSchema } from "./safety-score-v9-public";
import { SafetyScoreV9PillarFreshnessSchema, refineSafetyScoreV9PillarFreshness } from "./safety-score-v9-public-facts";
import { V9OpenEvidenceSchema } from "./safety-score-v9-open-evidence";
import {
  REPORT_CARDS_V9_NEXT_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9ResponseShape,
  V9PublicationHealthSchema,
  refineReportCardsV9Response,
} from "./report-cards-v9";

/** Report9's machine-readable reason for a null open-evidence block. */
export const V9_OPEN_EVIDENCE_UNAVAILABLE_REASONS = ["publication-predates-open-evidence"] as const;
export const V9OpenEvidenceUnavailableReasonSchema = z.enum(V9_OPEN_EVIDENCE_UNAVAILABLE_REASONS);
export type V9OpenEvidenceUnavailableReason = z.infer<typeof V9OpenEvidenceUnavailableReasonSchema>;

/**
 * Next report9 envelope: `openEvidence` is a required, nullable key. `null`
 * plus `openEvidenceUnavailableReason` means the source generation predates
 * the block; it never stands for zero open questions.
 */
const ReportCardsV9NextEnvelopeShape = {
  ...ReportCardsV9ResponseShape,
  lifecycle: z.literal("active"),
  schemaVersion: z.literal(REPORT_CARDS_V9_NEXT_RESPONSE_SCHEMA_VERSION),
  publicationHealth: V9PublicationHealthSchema,
  foreignCauseGaps: canonicalTextArray(),
  pillarFreshness: SafetyScoreV9PillarFreshnessSchema.optional(),
  openEvidence: V9OpenEvidenceSchema.nullable(),
  openEvidenceUnavailableReason: V9OpenEvidenceUnavailableReasonSchema.nullable(),
  /** T2 carrier: the publication union of documentation-classified cause gaps. */
  documentationCauseGaps: canonicalTextArray().optional(),
} as const;
export const ReportCardsV9NextResponseSchema = z.object({
  ...ReportCardsV9NextEnvelopeShape,
  cards: z.array(SafetyScoreV9ResolvedCurrentCardSchema),
}).strict().superRefine((value, ctx) => {
  refineReportCardsV9Response(value, ctx);
  refineReportCardsV9NextResponse(value, ctx);
  refineSafetyScoreV9PillarFreshness({ ...value, sourceGenerations: value.source.sourceGenerations }, ctx);
});
export type ReportCardsV9NextResponse = z.infer<typeof ReportCardsV9NextResponseSchema>;

/**
 * Report9-only envelope refinements. Kept out of `report-cards-v9.ts` (a
 * browser-reachable module) so the client chunk never carries them.
 */
export function refineReportCardsV9NextResponse(
  response: ReportCardsV9NextResponse,
  ctx: z.RefinementCtx,
): void {
  const cardsById = new Map(response.cards.map((card) => [card.id, card]));
  const unavailableReason = response.openEvidenceUnavailableReason;
  if ((response.openEvidence === null) !== (unavailableReason !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["openEvidenceUnavailableReason"],
      message: "A null open-evidence block requires its machine-readable reason, and a present block publishes none",
    });
  }
  const openEvidence = response.openEvidence;
  const documentationCauseGaps = response.documentationCauseGaps;
  if (documentationCauseGaps !== undefined) {
    const resolvable = new Set(response.foreignCauseGaps);
    for (const card of response.cards) {
      for (const gapId of card.localCauseGaps) resolvable.add(`${card.id}:gap:${gapId}`);
    }
    documentationCauseGaps.forEach((gapId, index) => {
      if (!resolvable.has(gapId)) {
        ctx.addIssue({
          code: "custom",
          path: ["documentationCauseGaps", index],
          message: "Documentation cause gaps must resolve to a published card or foreign gap",
        });
      }
    });
  }
  openEvidence?.byCard.forEach((entry, index) => {
    const card = cardsById.get(entry.id);
    if (card === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["openEvidence", "byCard", index, "id"],
        message: "Open-evidence counts must name a published card",
      });
      return;
    }
    if (entry.issuerNondisclosureReviewedAtSec !== undefined && entry.issuerNondisclosureReviewedAtSec > response.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["openEvidence", "byCard", index, "issuerNondisclosureReviewedAtSec"],
        message: "Issuer review proofs cannot postdate the publication",
      });
    }
    const annotated = entry.documentationOnlyLimited;
    if (annotated !== undefined) {
      for (let pillarIndex = 0; pillarIndex < annotated.length; pillarIndex++) {
        const pillar = annotated[pillarIndex]!;
        if (documentationCauseGaps === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["openEvidence", "byCard", index, "documentationOnlyLimited", pillarIndex],
            message: "A documentation-only pillar annotation requires the documentation gap set",
          });
        }
        const pillarRow = card.pillars[pillar];
        if (pillarRow.evidenceLevel !== "limited" || (pillarRow.limitedEvidenceCauses?.length ?? 0) === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["openEvidence", "byCard", index, "documentationOnlyLimited", pillarIndex],
            message: "Only a limited pillar with witnesses can be documented as documentation-only limited",
          });
        }
      }
    }
  });
  if (openEvidence !== null) {
    if (documentationCauseGaps === undefined && openEvidence.documentation.datums > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["documentationCauseGaps"],
        message: "Documentation datums require the publication documentation gap set",
      });
    }
    if (openEvidence.issuer.newestReviewedAtSec !== null && openEvidence.issuer.newestReviewedAtSec > response.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["openEvidence", "issuer", "newestReviewedAtSec"],
        message: "Issuer review proofs cannot postdate the publication",
      });
    }
  }
}
