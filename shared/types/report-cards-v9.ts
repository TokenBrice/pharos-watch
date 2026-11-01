import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import {
  SafetyScoreV9CompletenessSchema,
  SafetyScoreV9ResolvedCurrentCardSchema,
  SafetyScoreV9HistoricalCardSchema,
  SafetyScoreV9HistoricalTypedCardSchema,
  SafetyScoreV9WitnessHistoricalCardSchema,
  SafetyScoreV9DependencyProvenanceSchema,
  SafetyScoreV9CommonModeGroupsSchema,
  findSafetyScoreV9ParentAttributionIssues,
  type SafetyScoreV9CurrentCard,
  type SafetyScoreV9CardValidationInput,
} from "./safety-score-v9-public";
import type { V9OpenEvidence } from "./safety-score-v9-open-evidence";
import type { ReportCardsV9CurrentResponse } from "./report-cards-v9-current";
import { V9GradeSchema, V9ReasonCodeSchema } from "./safety-score-v9";
import { compareText, canonicalTextArray } from "./safety-score-v9-fact-primitives";
import { Sha256Schema } from "./safety-schema-primitives";
import { V9WrapperFormSchema } from "./safety-score-v9-wrapper";
import { DependencyTypeSchema } from "./dependency-types";
import {
  V9RatingStatusSchema, V9CompactPartialEvidenceSchema, refineV9RatingStatusFields,
  projectV9CompactPartialEvidence,
} from "./safety-score-v9-causes";
import { refineV9PublicGapContext } from "./safety-score-v9-public-causes";
import { SafetyScoreV9PillarFreshnessSchema, refineSafetyScoreV9PillarFreshness } from "./safety-score-v9-public-facts";

export const REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION = 9;
/** Archive-only report8 wire version: emitters stop at the report9 cutover. */
export const REPORT_CARDS_V9_REPORT8_SCHEMA_VERSION = 8;

const V9PublicationSimpleHoldReasonSchema = z
  .object({
    code: z.enum([
      "dex-stale",
      "dex-unavailable",
      "redemption-stale",
      "redemption-unavailable",
      "live-reserves-unavailable",
      "live-reserves-coverage-below-floor",
      "v9-public-materialization-pending",
    ]),
  })
  .strict();

const V9PublicationCoverageHoldReasonSchema = z
  .object({
    code: z.literal("coverage-floor-failed"),
    floorIds: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict();

const V9PublicationProducerHoldReasonSchema = z
  .object({
    code: z.literal("producer-failed-pipeline-gap"),
    assetId: z.string().min(1),
    source: z.enum(["parent-score", "reason", "wrapper-local"]),
    reasonCode: V9ReasonCodeSchema,
    path: z.string().min(1).max(240),
    effect: z.literal("pipeline-gap"),
  })
  .strict();

const V9PublicationAssessmentHoldReasonSchema = z
  .object({
    code: z.literal("assessment-failed"),
    detail: z.string().min(1).max(240),
  })
  .strict();

export const V9PublicationHoldReasonSchema = z.discriminatedUnion("code", [
  V9PublicationSimpleHoldReasonSchema,
  V9PublicationCoverageHoldReasonSchema,
  V9PublicationProducerHoldReasonSchema,
  V9PublicationAssessmentHoldReasonSchema,
]);
export type V9PublicationHoldReason = z.infer<typeof V9PublicationHoldReasonSchema>;

export const V9PublicationHealthSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(["current", "held"]),
    acceptedPublicationGenerationId: z.string().min(1).nullable(),
    acceptedAtSec: z.number().int().nonnegative().nullable(),
    attemptedAtSec: z.number().int().nonnegative(),
    heldSinceSec: z.number().int().nonnegative().nullable(),
    reasons: z.array(V9PublicationHoldReasonSchema).max(24),
  })
  .strict()
  .superRefine((health, ctx) => {
    const acceptedFieldsMatch =
      (health.acceptedPublicationGenerationId === null) ===
      (health.acceptedAtSec === null);
    if (!acceptedFieldsMatch) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptedPublicationGenerationId"],
        message: "V9 publication health accepted identity and time must be present together",
      });
    }
    if (health.acceptedAtSec !== null && health.acceptedAtSec > health.attemptedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptedAtSec"],
        message: "V9 accepted publication cannot postdate the latest attempt",
      });
    }
    if (
      health.status === "current" &&
      (
        health.acceptedPublicationGenerationId === null ||
        health.acceptedAtSec === null ||
        health.heldSinceSec !== null ||
        health.reasons.length !== 0
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Current V9 publication health requires an accepted publication and no hold fields",
      });
    }
    if (
      health.status === "held" &&
      (
        health.heldSinceSec === null ||
        health.heldSinceSec > health.attemptedAtSec ||
        health.reasons.length === 0
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Held V9 publication health requires a bounded reason set and hold start",
      });
    }
  });
export type V9PublicationHealth = z.infer<typeof V9PublicationHealthSchema>;

export const ReportCardsV9DependencyEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(["serial", "basket"]),
    dependencyType: DependencyTypeSchema.optional(),
    materiality: z.enum(["serial", "serial-blocked", "basket-weighted", "basket-bounded-unknown"]),
    weight: z.number().finite().min(0).max(1).nullable(),
    upstreamScore: z.number().finite().min(0).max(100).nullable(),
    wrapperForm: V9WrapperFormSchema.nullable().optional(),
    provenance: SafetyScoreV9DependencyProvenanceSchema.optional(),
  })
  .strict();
export type ReportCardsV9DependencyEdge = z.infer<typeof ReportCardsV9DependencyEdgeSchema>;

export const ReportCardsV9DependencyGraphSchema = z
  .object({
    edges: z.array(ReportCardsV9DependencyEdgeSchema),
  })
  .strict()
  .superRefine((graph, ctx) => {
    let previous: string | null = null;
    graph.edges.forEach((edge, index) => {
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
      if (previous !== null && compareText(previous, key) >= 0) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "Dependency edges must be unique and sorted by (from, to, kind)" });
      }
      if (edge.kind === "basket" && edge.wrapperForm != null) {
        ctx.addIssue({ code: "custom", path: ["edges", index, "wrapperForm"], message: "Basket edges cannot carry a wrapper form" });
      }
      previous = key;
    });
  });
export type ReportCardsV9DependencyGraph = z.infer<typeof ReportCardsV9DependencyGraphSchema>;

/**
 * Derives the native V9 graph projection. V9 serial and basket dependencies
 * intentionally do not reuse the V8 dependency type or weight semantics.
 */
export function buildReportCardsV9DependencyGraph(
  cards: readonly Pick<SafetyScoreV9CurrentCard, "id" | "dependencies">[],
): ReportCardsV9DependencyGraph {
  const edges: ReportCardsV9DependencyEdge[] = [];
  for (const card of cards) {
    for (const dependency of card.dependencies.serial) {
      edges.push({
        from: dependency.upstreamAssetId,
        to: card.id,
        kind: "serial",
        materiality: dependency.blocked ? "serial-blocked" : "serial",
        weight: null,
        upstreamScore: dependency.score,
        ...(dependency.dependencyType === undefined ? {} : { dependencyType: dependency.dependencyType }),
        ...(dependency.wrapperForm === undefined ? {} : { wrapperForm: dependency.wrapperForm }),
        ...(dependency.provenance === undefined ? {} : { provenance: dependency.provenance }),
      });
    }
    for (const dependency of card.dependencies.basket) {
      edges.push({
        from: dependency.upstreamAssetId,
        to: card.id,
        kind: "basket",
        materiality: dependency.boundedUnknown ? "basket-bounded-unknown" : "basket-weighted",
        weight: dependency.weight,
        upstreamScore: dependency.score,
        ...(dependency.dependencyType === undefined ? {} : { dependencyType: dependency.dependencyType }),
        ...(dependency.wrapperForm === undefined ? {} : { wrapperForm: dependency.wrapperForm }),
        ...(dependency.provenance === undefined ? {} : { provenance: dependency.provenance }),
      });
    }
  }
  return {
    edges: edges.sort((left, right) =>
      compareText(
        `${left.from}\u0000${left.to}\u0000${left.kind}`,
        `${right.from}\u0000${right.to}\u0000${right.kind}`,
      ),
    ),
  };
}

/**
 * Structural equality for parsed JSON values: object key order is ignored,
 * array order is significant. Used for exact-projection refinements, where
 * Zod reorders parsed object keys to schema order.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]));
}

function isUniqueSorted(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

/**
 * Shared public V9 report-card envelope fields. The report contract remains
 * distinct from the retained evaluator envelope even while shadow history is
 * its storage source.
 */
export const ReportCardsV9ResponseShape = {
  model: z.literal("v9"),
  lifecycle: z.enum(["shadow", "active"]),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  methodology: z
    .object({
      version: z.string().trim().min(1),
      policy: z.object({ id: z.string().trim().min(1), semanticDigest: Sha256Schema }).strict(),
    })
    .strict(),
  asOfSec: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completeness: SafetyScoreV9CompletenessSchema,
  source: z
    .object({
      candidateId: z.string().trim().min(1),
      factSetDigest: Sha256Schema,
      resultDigest: Sha256Schema,
      sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
    })
    .strict(),
  dependencyGraph: ReportCardsV9DependencyGraphSchema,
  commonModeGroups: SafetyScoreV9CommonModeGroupsSchema.optional(),
} as const;

export function refineReportCardsV9Response(
  response: {
    safetyScoreIdentity: z.infer<typeof SafetyScoreV9PublicationIdentitySchema>;
    methodology: {
      version: string;
      policy: { id: string; semanticDigest: string };
    };
    asOfSec: number;
    updatedAt: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly Omit<SafetyScoreV9CardValidationInput, "breakdowns">[];
    foreignCauseGaps: readonly string[];
    schemaVersion?: number;
    commonModeGroups?: z.infer<typeof SafetyScoreV9CommonModeGroupsSchema>;
    dependencyGraph: ReportCardsV9DependencyGraph;
    documentationCauseGaps?: readonly string[];
    openEvidence?: V9OpenEvidence | null;
    openEvidenceUnavailableReason?: V9OpenEvidenceUnavailableReason | null;
  },
  ctx: z.RefinementCtx,
  historical = false,
): void {
  refineV9PublicGapContext(response, ctx);
  const cardsById = new Map(response.cards.map((card) => [card.id, card]));
  response.commonModeGroups?.forEach((group, groupIndex) => {
    if (group.memberAssetIds.some((id) => !cardsById.has(id))) {
      ctx.addIssue({ code: "custom", path: ["commonModeGroups", groupIndex, "memberAssetIds"], message: "Common-mode members must have public cards" });
    }
    group.pricedEffects?.forEach((effect, effectIndex) => {
      const card = cardsById.get(effect.assetId);
      if (!card || effect.capIndices.some(index => !historical || card.caps[index]?.source !== "structural") ||
          effect.deploymentAdjustmentIndices.some((index) =>
            card.scoreTrace.deploymentRisk.adjustments[index]?.failureDomainKey !== group.id)) {
        ctx.addIssue({ code: "custom", path: ["commonModeGroups", groupIndex, "pricedEffects", effectIndex], message: "Common-mode effects must reference existing priced card effects" });
      }
    });
  });
  const identity = response.safetyScoreIdentity;
  if (
    identity.methodologyVersion !== response.methodology.version ||
    identity.policyId !== response.methodology.policy.id ||
    identity.policyDigest !== response.methodology.policy.semanticDigest
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["safetyScoreIdentity"],
      message: "V9 public identity must match the response methodology and policy",
    });
  }
  if (response.updatedAt < response.asOfSec) {
    ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "V9 publication cannot predate evidence" });
  }
  if (response.cards.length !== response.completeness.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 public card set is not complete" });
  }
  const cardIds = response.cards.map((card) => card.id);
  if (!isUniqueSorted(cardIds)) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 public card IDs must be unique and sorted" });
  }
  const notRatedIds = response.cards.filter((card) => card.grade === "NR").map((card) => card.id);
  if (!sameJson(notRatedIds, response.completeness.notRatedIds)) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness"],
      message: "V9 public NR membership must match completeness",
    });
  }
  const pipelineGapIds = response.cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
  if (!sameJson(pipelineGapIds, response.completeness.pipelineGapIds) ||
      response.cards.filter((card) => card.ratingStatus === "rated").length !== response.completeness.ratedCount) {
    ctx.addIssue({ code: "custom", path: ["completeness"], message: "Pipeline-gap/rated membership must match disjoint completeness" });
  }
  const expectedGraph = buildReportCardsV9DependencyGraph(response.cards);
  if (!sameJson(response.dependencyGraph, expectedGraph)) {
    ctx.addIssue({
      code: "custom",
      path: ["dependencyGraph"],
      message: "V9 dependency graph must exactly project the V9 card dependency summaries",
    });
  }
  for (const issue of findSafetyScoreV9ParentAttributionIssues(response)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
  }
  if (response.openEvidence !== undefined) {
    const unavailableReason = response.openEvidenceUnavailableReason ?? null;
    if ((response.openEvidence === null) !== (unavailableReason !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["openEvidenceUnavailableReason"],
        message: "A null open-evidence block requires its machine-readable reason, and a present block publishes none",
      });
    }
  }
  const openEvidence = response.openEvidence ?? null;
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

/** Report9's machine-readable reason for a null open-evidence block. */
export const V9_OPEN_EVIDENCE_UNAVAILABLE_REASONS = ["publication-predates-open-evidence"] as const;
export const V9OpenEvidenceUnavailableReasonSchema = z.enum(V9_OPEN_EVIDENCE_UNAVAILABLE_REASONS);
export type V9OpenEvidenceUnavailableReason = z.infer<typeof V9OpenEvidenceUnavailableReasonSchema>;

/** Envelope fields shared by the live report and its archive-only predecessors. */
export const ReportCardsV9EnvelopeBaseShape = {
  ...ReportCardsV9ResponseShape,
  lifecycle: z.literal("active"),
  publicationHealth: V9PublicationHealthSchema,
  foreignCauseGaps: canonicalTextArray(),
  pillarFreshness: SafetyScoreV9PillarFreshnessSchema.optional(),
} as const;

export type {
  ReportCardsV9CurrentResponse,
  ReportCardsV9Response,
} from "./report-cards-v9-current";

/** Archive-only report8 envelope: the shape live producers emitted before report9. */
const HistoricalReport8EnvelopeShape = {
  ...ReportCardsV9EnvelopeBaseShape,
  schemaVersion: z.literal(REPORT_CARDS_V9_REPORT8_SCHEMA_VERSION),
} as const;

/**
 * Browser admission for `ReportCardsV9BrowserResponseSchema` (the module browser
 * readers import). Report8 validates as-is; report9 keeps its required-nullable
 * pair with the block passed through. Both are admitted by the strict report8
 * envelope — cards, graph, gaps and clocks included — so this module never pulls
 * the report9/OpenEvidence validators into the client bundle. The coverage
 * reader validates the block it renders with `V9OpenEvidenceSchema`
 * (`src/lib/safety-score-data-coverage.ts`), so an unusable block renders as
 * unavailable, never zero.
 */
function rejectBrowserReport(message: string): z.ZodSafeParseResult<ReportCardsV9CurrentResponse> {
  return z.never({ error: message }).safeParse(null);
}

function parseReportCardsV9BrowserResponse(input: unknown): z.ZodSafeParseResult<ReportCardsV9CurrentResponse> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return rejectBrowserReport("Report cards payload must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION) {
    const archived = HistoricalResolvedReportCardsV9ResponseSchema.safeParse(input);
    return archived.success
      ? { success: true, data: projectArchivedReport8ToReader(archived.data) }
      : rejectBrowserReport(archived.error.issues[0]?.message ?? "Invalid report8 report-cards payload");
  }
  const openEvidence = record.openEvidence;
  const unavailableReason = record.openEvidenceUnavailableReason;
  if (openEvidence === undefined || unavailableReason === undefined) {
    return rejectBrowserReport("Report9 requires openEvidence and openEvidenceUnavailableReason");
  }
  if (openEvidence !== null && (typeof openEvidence !== "object" || Array.isArray(openEvidence))) {
    return rejectBrowserReport("Report9 openEvidence must be a block or null");
  }
  if (unavailableReason !== null && unavailableReason !== V9_OPEN_EVIDENCE_UNAVAILABLE_REASONS[0]) {
    return rejectBrowserReport("Report9 openEvidenceUnavailableReason must name a published reason");
  }
  if ((openEvidence === null) !== (unavailableReason !== null)) {
    return rejectBrowserReport(
      "A null open-evidence block requires its machine-readable reason, and a present block publishes none",
    );
  }
  const documentationCauseGaps = record.documentationCauseGaps;
  if (documentationCauseGaps !== undefined &&
      (!Array.isArray(documentationCauseGaps) || !documentationCauseGaps.every((id) => typeof id === "string"))) {
    return rejectBrowserReport("Report9 documentationCauseGaps must be an array of gap ids");
  }
  const {
    openEvidence: _block,
    openEvidenceUnavailableReason: _reason,
    documentationCauseGaps: _gaps,
    ...report8
  } = record;
  const parsed = HistoricalResolvedReportCardsV9ResponseSchema.safeParse({
    ...report8,
    schemaVersion: REPORT_CARDS_V9_REPORT8_SCHEMA_VERSION,
  });
  if (!parsed.success) {
    return rejectBrowserReport(parsed.error.issues[0]?.message ?? "Invalid report9 report-cards payload");
  }
  return {
    success: true,
    data: {
      ...parsed.data,
      schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
      openEvidence: openEvidence as V9OpenEvidence | null,
      openEvidenceUnavailableReason: unavailableReason as V9OpenEvidenceUnavailableReason | null,
      ...(documentationCauseGaps === undefined
        ? {}
        : { documentationCauseGaps: documentationCauseGaps as string[] }),
    },
  };
}
export const ReportCardsV9BrowserResponseSchema = {
  safeParse: parseReportCardsV9BrowserResponse,
};

/** Archive-only report7 validation; live producers remain report8-only. */
const HistoricalReportCardsV9ResponseShape = {
  ...ReportCardsV9ResponseShape,
  lifecycle: z.literal("active"),
  schemaVersion: z.literal(7),
  publicationHealth: V9PublicationHealthSchema,
  foreignCauseGaps: canonicalTextArray(),
};
export const HistoricalReportCardsV9ResponseSchema = z.object({
  ...HistoricalReportCardsV9ResponseShape,
  cards: z.array(SafetyScoreV9HistoricalCardSchema),
}).strict().superRefine((response, ctx) => refineReportCardsV9Response(response, ctx, true));
export const WitnessHistoricalReportCardsV9ResponseSchema = z.object({
  ...HistoricalReportCardsV9ResponseShape,
  cards: z.array(SafetyScoreV9WitnessHistoricalCardSchema),
}).strict().superRefine((response, ctx) => refineReportCardsV9Response(response, ctx, true));

/** Archive-only report8 before v10.29: typed routes and inline control details. */
export const HistoricalTypedReportCardsV9ResponseSchema = z.object({
  ...HistoricalReport8EnvelopeShape,
  methodology: ReportCardsV9ResponseShape.methodology.extend({
    version: z.string().regex(/^10\.(?:1[1-9]|2[0-8])$/),
  }),
  cards: z.array(SafetyScoreV9HistoricalTypedCardSchema),
}).strict().superRefine((value, ctx) => {
  refineReportCardsV9Response(value, ctx, true);
  refineSafetyScoreV9PillarFreshness({ ...value, sourceGenerations: value.source.sourceGenerations }, ctx);
});

/** Archive-only report8 from v10.29 to the report9 cutover: resolved cards, no open-evidence block. */
export const HistoricalResolvedReportCardsV9ResponseSchema = z.object({
  ...HistoricalReport8EnvelopeShape,
  cards: z.array(SafetyScoreV9ResolvedCurrentCardSchema),
}).strict().superRefine((value, ctx) => {
  refineReportCardsV9Response(value, ctx);
  refineSafetyScoreV9PillarFreshness({ ...value, sourceGenerations: value.source.sourceGenerations }, ctx);
});

/**
 * Read an archive-only report8 as the current report view. The block cannot
 * exist in that wire version, so it publishes the machine reason instead of a
 * zero count (R1).
 */
export function projectArchivedReport8ToReader(
  response: z.infer<typeof HistoricalResolvedReportCardsV9ResponseSchema>,
): ReportCardsV9CurrentResponse {
  return {
    ...response,
    schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
    openEvidence: null,
    openEvidenceUnavailableReason: "publication-predates-open-evidence",
  };
}

/**
 * Free-lane projection of the current V9 publication: one grade per coin and
 * nothing else. Served without an API key; keep it small and stable.
 */
export const SafetyGradesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    model: z.literal("v9"),
    methodologyVersion: z.string().trim().min(1),
    asOfSec: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    publicationStatus: z.enum(["current", "held"]),
    grades: z.array(
      z
        .object({
          id: z.string().min(1),
          score: z.number().min(0).max(100).nullable(),
          grade: V9GradeSchema.nullable(),
          ratingStatus: V9RatingStatusSchema,
          partialEvidence: V9CompactPartialEvidenceSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict().superRefine((response, ctx) => {
    for (const row of response.grades) refineV9RatingStatusFields(row, ctx);
  });
export type SafetyGradesResponse = z.infer<typeof SafetyGradesResponseSchema>;

export function projectSafetyGrades(snapshot: ReportCardsV9CurrentResponse): SafetyGradesResponse {
  return {
    schemaVersion: 1,
    model: "v9",
    methodologyVersion: snapshot.methodology.version,
    asOfSec: snapshot.asOfSec,
    updatedAt: snapshot.updatedAt,
    publicationStatus: snapshot.publicationHealth.status,
    grades: snapshot.cards.map((card) => ({
      id: card.id, score: card.score, grade: card.grade, ratingStatus: card.ratingStatus,
      partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence),
    })),
  };
}
