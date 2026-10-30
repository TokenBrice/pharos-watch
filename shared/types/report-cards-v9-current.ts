import { z } from "zod";
import {
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9ResolvedCurrentCardSchema,
} from "./safety-score-v9-public";
import { V9OpenEvidenceSchema } from "./safety-score-v9-open-evidence";
import { refineSafetyScoreV9PillarFreshness } from "./safety-score-v9-public-facts";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
import {
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9EnvelopeBaseShape,
  V9OpenEvidenceUnavailableReasonSchema,
  refineReportCardsV9Response,
} from "./report-cards-v9";

/**
 * Current report9 envelope: `openEvidence` is a required, nullable key. `null`
 * plus `openEvidenceUnavailableReason` means the source generation predates
 * the block; it never stands for zero open questions.
 *
 * This is the only report9 definition. It lives outside `report-cards-v9.ts`
 * (the module browser readers import) so the OpenEvidence validators stay out
 * of the client bundle; the browser admits the same bytes through
 * `ReportCardsV9BrowserResponseSchema` and its coverage reader validates the
 * block with `V9OpenEvidenceSchema`.
 */
const ReportCardsV9CurrentEnvelopeShape = {
  ...ReportCardsV9EnvelopeBaseShape,
  schemaVersion: z.literal(REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION),
  openEvidence: V9OpenEvidenceSchema.nullable(),
  openEvidenceUnavailableReason: V9OpenEvidenceUnavailableReasonSchema.nullable(),
  /** T2 carrier: the publication union of documentation-classified cause gaps. */
  documentationCauseGaps: canonicalTextArray().optional(),
} as const;
export const ReportCardsV9CurrentResponseSchema = z.object({
  ...ReportCardsV9CurrentEnvelopeShape,
  cards: z.array(SafetyScoreV9ResolvedCurrentCardSchema),
}).strict().superRefine((value, ctx) => {
  refineReportCardsV9Response(value, ctx);
  refineSafetyScoreV9PillarFreshness({ ...value, sourceGenerations: value.source.sourceGenerations }, ctx);
});
export type ReportCardsV9CurrentResponse = z.infer<typeof ReportCardsV9CurrentResponseSchema>;

/** Trusted materializer input: canonical cards, with the same public refinements. */
export const ReportCardsV9CanonicalProjectionSchema = z.object({
  ...ReportCardsV9CurrentEnvelopeShape,
  cards: z.array(SafetyScoreV9CurrentCardSchema),
}).strict().superRefine((value, ctx) => {
  refineReportCardsV9Response(value, ctx);
  refineSafetyScoreV9PillarFreshness({ ...value, sourceGenerations: value.source.sourceGenerations }, ctx);
});

/**
 * Live V9 producers and consumers use only the current report contract.
 */
export const ReportCardsV9ResponseSchema = ReportCardsV9CurrentResponseSchema;
export type ReportCardsV9Response = ReportCardsV9CurrentResponse;
