import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import {
  SafetyScoreV9CompletenessSchema,
  SafetyScoreV9CurrentCardSchema,
  findSafetyScoreV9ParentAttributionIssues,
  type SafetyScoreV9CurrentCard,
} from "./safety-score-v9-public";
import { V9ReasonCodeSchema } from "./safety-score-v9";
import { compareText } from "./safety-score-v9-fact-primitives";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION = 4;

export const V9_PUBLICATION_HOLD_REASON_CODES = [
  "dex-stale",
  "dex-unavailable",
  "redemption-stale",
  "redemption-unavailable",
  "live-reserves-unavailable",
  "coverage-floor-failed",
  "producer-failed-downgrade",
  "producer-failed-nr",
  "assessment-failed",
] as const;

const V9PublicationSimpleHoldReasonSchema = z
  .object({
    code: z.enum([
      "dex-stale",
      "dex-unavailable",
      "redemption-stale",
      "redemption-unavailable",
      "live-reserves-unavailable",
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
    code: z.enum(["producer-failed-downgrade", "producer-failed-nr"]),
    assetId: z.string().min(1),
    source: z.enum(["parent-score", "reason", "wrapper-local"]),
    reasonCode: V9ReasonCodeSchema,
    path: z.string().min(1).max(240),
    effect: z.enum(["score-or-grade-downgrade", "not-rated"]),
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
    schemaVersion: z.literal(1),
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
    materiality: z.enum(["serial", "serial-blocked", "basket-weighted", "basket-bounded-unknown"]),
    weight: z.number().finite().min(0).max(1).nullable(),
    upstreamScore: z.number().finite().min(0).max(100).nullable(),
  })
  .strict();
export type ReportCardsV9DependencyEdge = z.infer<typeof ReportCardsV9DependencyEdgeSchema>;

export const ReportCardsV9DependencyGraphSchema = z
  .object({
    edges: z.array(ReportCardsV9DependencyEdgeSchema),
  })
  .strict();
export type ReportCardsV9DependencyGraph = z.infer<typeof ReportCardsV9DependencyGraphSchema>;

/**
 * Derives the native V9 graph projection. V9 serial and basket dependencies
 * intentionally do not reuse the V8 dependency type or weight semantics.
 */
export function buildReportCardsV9DependencyGraph(
  cards: readonly SafetyScoreV9CurrentCard[],
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
const ReportCardsV9ResponseShape = {
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
} as const;

function refineReportCardsV9Response(
  response: {
    safetyScoreIdentity: z.infer<typeof SafetyScoreV9PublicationIdentitySchema>;
    methodology: {
      version: string;
      policy: { id: string; semanticDigest: string };
    };
    asOfSec: number;
    updatedAt: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CurrentCard[];
    dependencyGraph: ReportCardsV9DependencyGraph;
  },
  ctx: z.RefinementCtx,
): void {
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
  const expectedGraph = buildReportCardsV9DependencyGraph(response.cards);
  if (!sameJson(response.dependencyGraph, expectedGraph)) {
    ctx.addIssue({
      code: "custom",
      path: ["dependencyGraph"],
      message: "V9 dependency graph must exactly project the V9 card dependency summaries",
    });
  }
  for (const issue of findSafetyScoreV9ParentAttributionIssues(response.cards)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
  }
}

/** Current public report contract. Report-v4 adds compact component breakdowns. */
export const ReportCardsV9CurrentResponseSchema = z
  .object({
    ...ReportCardsV9ResponseShape,
    lifecycle: z.literal("active"),
    schemaVersion: z.literal(REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION),
    publicationHealth: V9PublicationHealthSchema,
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine(refineReportCardsV9Response);
export type ReportCardsV9CurrentResponse = z.infer<typeof ReportCardsV9CurrentResponseSchema>;

/**
 * Live V9 producers and consumers use only the current report contract.
 */
export const ReportCardsV9ResponseSchema = ReportCardsV9CurrentResponseSchema;
export type ReportCardsV9Response = ReportCardsV9CurrentResponse;
