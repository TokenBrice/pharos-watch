import { z } from "zod";
import { issue, UnixSecondsSchema } from "./safety-schema-primitives";
import { V9DocumentationReasonSchema, V9QualityPillarSchema, V9ReasonCodeSchema } from "./safety-score-v9";
import { canonicalTextArray, V9EvidenceResponsibilitySchema } from "./safety-score-v9-fact-primitives";
import { isUniqueSorted, RESPONSIBILITIES } from "./safety-score-v9-public-facts";

/**
 * Open-evidence contract: counting semantics, question identity and the block
 * the publication and report9 envelopes validate. It lives in its own module
 * (rather than `safety-score-v9-public.ts`, which browser readers import) so
 * the validators only ship where the block is actually read or written: the
 * worker publication path, the dataset/audit scripts and the `/coverage/`
 * reader. The documentation-reason vocabulary stays in `safety-score-v9.ts` —
 * its single authority.
 */

/** Published open-evidence counting semantics; a definition change renames this literal. */
export const V9_OPEN_EVIDENCE_SEMANTICS = "open-question-v1" as const;

/** The three disjoint published question buckets; they sum to `totals.questions`. */
export const V9_OPEN_QUESTION_BUCKETS = ["documentation", "issuer", "open"] as const;
export const V9OpenQuestionBucketSchema = z.enum(V9_OPEN_QUESTION_BUCKETS);
export type V9OpenQuestionBucket = z.infer<typeof V9OpenQuestionBucketSchema>;

/** Scope kinds a question key dispatches on. */
export const V9_OPEN_QUESTION_SCOPE_KINDS = [
  "route", "control", "reserve-exposure", "component", "peg", "dependency", "path",
] as const;
export const V9OpenQuestionScopeKindSchema = z.enum(V9_OPEN_QUESTION_SCOPE_KINDS);
export type V9OpenQuestionScopeKind = z.infer<typeof V9OpenQuestionScopeKindSchema>;

/**
 * Open-question identity `<rootAssetId>|<scopeKind>|<scopeIdentity>`, derived at
 * publication build time and never stored. Route identities keep their own
 * `<lane>|<tail>` separator, so only the first two separators are structural.
 */
export const V9QuestionKeySchema = z.string().superRefine((value, ctx) => {
  const rootEnd = value.indexOf("|");
  const kindEnd = rootEnd < 0 ? -1 : value.indexOf("|", rootEnd + 1);
  if (value.trim() !== value || rootEnd <= 0 || kindEnd <= rootEnd + 1 || kindEnd === value.length - 1) {
    issue(ctx, undefined, "Open-question keys must be <rootAssetId>|<scopeKind>|<scopeIdentity>");
    return;
  }
  if (!V9OpenQuestionScopeKindSchema.safeParse(value.slice(rootEnd + 1, kindEnd)).success) {
    issue(ctx, undefined, "Open-question keys must name a supported scope kind");
  }
});
export type V9QuestionKey = z.infer<typeof V9QuestionKeySchema>;

/** The annotated pillar vocabulary is the single `V9QualityPillarSchema`; never restate it. */

const V9OpenEvidenceCountSchema = z.number().int().nonnegative();

export const V9OpenEvidenceTotalsSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    open: V9OpenEvidenceCountSchema,
    issuer: V9OpenEvidenceCountSchema,
    documentation: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict()
  .superRefine((totals, ctx) => {
    if (totals.questions !== totals.open + totals.issuer + totals.documentation) {
      issue(ctx, undefined, "Open-evidence buckets must sum to the question total");
    }
  });
export type V9OpenEvidenceTotals = z.infer<typeof V9OpenEvidenceTotalsSchema>;

/** Headline owner of a question; `mixed` is the multi-owner remainder, not a responsibility. */
export const V9_OPEN_EVIDENCE_MIXED_OWNER = "mixed" as const;

const V9OpenEvidenceOwnerSchema = z
  .object({
    responsibility: z.union([V9EvidenceResponsibilitySchema, z.literal(V9_OPEN_EVIDENCE_MIXED_OWNER)]),
    questions: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict();

const V9OpenEvidenceReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    /**
     * Bucket whose questions the row counts. Documentation rows are the
     * documentation inventory only: they never enter the headline or issuer
     * number, which are read from `totals`.
     */
    bucket: V9OpenQuestionBucketSchema,
    questions: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict();

const V9OpenEvidenceDocumentationSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    datums: V9OpenEvidenceCountSchema,
    facts: V9OpenEvidenceCountSchema,
    reasons: z
      .array(
        z
          .object({
            reason: V9DocumentationReasonSchema,
            datums: V9OpenEvidenceCountSchema,
          })
          .strict(),
      ),
  })
  .strict()
  .superRefine((documentation, ctx) => {
    if (documentation.facts > documentation.datums) {
      issue(ctx, ["facts"], "Documentation facts cannot exceed its datum count");
    }
    if (!isUniqueSorted(documentation.reasons.map((row) => row.reason))) {
      issue(ctx, ["reasons"], "Documentation reason rows must be unique and sorted");
    }
    if (documentation.reasons.reduce((sum, row) => sum + row.datums, 0) !== documentation.datums) {
      issue(ctx, ["reasons"], "Every documentation datum carries exactly one reason");
    }
  });

const V9OpenEvidenceIssuerSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    assets: V9OpenEvidenceCountSchema,
    oldestReviewedAtSec: UnixSecondsSchema.nullable(),
    newestReviewedAtSec: UnixSecondsSchema.nullable(),
  })
  .strict()
  .superRefine((issuer, ctx) => {
    if (issuer.assets > issuer.questions) {
      issue(ctx, ["assets"], "Issuer-reviewed assets cannot outnumber issuer questions");
    }
    if ((issuer.oldestReviewedAtSec === null) !== (issuer.newestReviewedAtSec === null)) {
      issue(ctx, ["oldestReviewedAtSec"], "Issuer review dates publish together or not at all");
    } else if (
      issuer.oldestReviewedAtSec !== null &&
      issuer.newestReviewedAtSec !== null &&
      issuer.oldestReviewedAtSec > issuer.newestReviewedAtSec
    ) {
      issue(ctx, ["oldestReviewedAtSec"], "Issuer review windows cannot start after they end");
    }
  });

export const V9OpenEvidenceByCardSchema = z
  .object({
    id: z.string().min(1),
    /** Questions carried on this card that landed in the headline "open" bucket only. */
    openBucketQuestionsCarried: V9OpenEvidenceCountSchema,
    /** Open-bucket questions whose root asset is not this card (inherited from a parent). */
    inheritedOpenBucketQuestionsCarried: V9OpenEvidenceCountSchema,
    /** Obligations behind this card's open-bucket questions; excludes issuer and documentation ones. */
    openBucketObligationsCarried: V9OpenEvidenceCountSchema,
    /** Documentation-classed obligations this card carries, from any bucket. */
    documentationObligationsCarried: V9OpenEvidenceCountSchema,
    /**
     * Pillars this card limits only through documentation gaps: the pillar is
     * `limited`, its witnesses are non-empty, and every witness is
     * documentation-classified. Absent means plain limited — never publish `[]`.
     */
    documentationOnlyLimited: canonicalTextArray(1).pipe(z.array(V9QualityPillarSchema).max(3)).optional(),
    /** Earliest recorded issuer review behind this card's issuer-bucket questions; absent when none is dated. */
    issuerNondisclosureReviewedAtSec: UnixSecondsSchema.optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (card.inheritedOpenBucketQuestionsCarried > card.openBucketQuestionsCarried) {
      issue(ctx, ["inheritedOpenBucketQuestionsCarried"], "Inherited open questions cannot exceed open questions carried");
    }
  });
export type V9OpenEvidenceByCard = z.infer<typeof V9OpenEvidenceByCardSchema>;

/**
 * Server-computed three-number block; `open-questions.ts` is its only authority.
 * A card omitted from `byCard` carries zero obligations whenever the block
 * itself is present; a present card's counts are measured, never inferred.
 */
export const V9OpenEvidenceSchema = z
  .object({
    semantics: z.literal(V9_OPEN_EVIDENCE_SEMANTICS),
    totals: V9OpenEvidenceTotalsSchema,
    owners: z.array(V9OpenEvidenceOwnerSchema),
    reasons: z.array(V9OpenEvidenceReasonSchema),
    documentation: V9OpenEvidenceDocumentationSchema,
    issuer: V9OpenEvidenceIssuerSchema,
    byCard: z.array(V9OpenEvidenceByCardSchema),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.documentation.questions !== evidence.totals.documentation) {
      issue(ctx, ["documentation", "questions"], "Documentation detail must match its bucket");
    }
    if (evidence.documentation.datums > evidence.totals.obligations) {
      issue(ctx, ["documentation", "datums"], "Documentation datums cannot exceed published obligations");
    }
    if (evidence.byCard.reduce((sum, card) => sum + card.documentationObligationsCarried, 0) <
        evidence.documentation.datums) {
      issue(ctx, ["byCard"], "Per-card documentation obligations cannot undercount the documentation datums");
    }
    // Canonical order keeps replay bytes stable: canonical responsibilities, `mixed` last.
    const ownerOrder = new Map<string, number>([
      ...RESPONSIBILITIES.map((responsibility, index) => [responsibility, index] as const),
      [V9_OPEN_EVIDENCE_MIXED_OWNER, RESPONSIBILITIES.length] as const,
    ]);
    const ownerRanks = evidence.owners.map((owner) => ownerOrder.get(owner.responsibility)!);
    if (ownerRanks.some((rank, index) => index > 0 && ownerRanks[index - 1]! >= rank)) {
      issue(ctx, ["owners"], "Owner rows must be unique and in canonical responsibility order");
    }
    if (evidence.owners.reduce((sum, owner) => sum + owner.questions, 0) !== evidence.totals.open) {
      issue(ctx, ["owners"], "Headline owner counts must partition the open bucket");
    }
    const reasonIdentities = evidence.reasons.map((row) => `${row.bucket}\u0000${row.code}`);
    if (!isUniqueSorted(reasonIdentities)) {
      issue(ctx, ["reasons"], "Reason rows must be unique and sorted by bucket and code");
    }
    if (!isUniqueSorted(evidence.byCard.map((card) => card.id))) {
      issue(ctx, ["byCard"], "Open-evidence card IDs must be unique and sorted");
    }
    if (evidence.totals.questions > 0 && evidence.byCard.length === 0) {
      issue(ctx, ["byCard"], "Published questions require a carrying card");
    }
  });
export type V9OpenEvidence = z.infer<typeof V9OpenEvidenceSchema>;
