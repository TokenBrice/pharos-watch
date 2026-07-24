import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import {
  SafetyScoreV9CompletenessSchema,
  SafetyScoreV9CausalCardSchema,
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9PreviousCardSchema,
  findSafetyScoreV9ParentAttributionIssues,
  type SafetyScoreV9Card,
  type SafetyScoreV9CausalCard,
  type SafetyScoreV9CurrentCard,
} from "./safety-score-v9-public";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION = 3;
export const REPORT_CARDS_V9_PREVIOUS_RESPONSE_SCHEMA_VERSION = 2;
export const REPORT_CARDS_V9_LEGACY_RESPONSE_SCHEMA_VERSION = 1;

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
  cards: readonly SafetyScoreV9Card[],
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
 * distinct from the candidate evaluator envelope even while shadow data is its
 * pre-activation source.
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
    cards: readonly SafetyScoreV9Card[];
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
  const currentCards = response.cards.filter(
    (
      card,
    ): card is SafetyScoreV9CurrentCard | SafetyScoreV9CausalCard =>
      "scoreTrace" in card &&
      (
        card.scoreTrace.schemaVersion === 2 ||
        card.scoreTrace.schemaVersion === 3
      ),
  );
  for (const issue of findSafetyScoreV9ParentAttributionIssues(currentCards)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
  }
}

/** Compatibility reader for report-v1 envelopes carrying retained trace-v1 cards. */
export const ReportCardsV9LegacyResponseSchema = z
  .object({
    ...ReportCardsV9ResponseShape,
    schemaVersion: z.literal(REPORT_CARDS_V9_LEGACY_RESPONSE_SCHEMA_VERSION),
    cards: z.array(SafetyScoreV9PreviousCardSchema),
  })
  .strict()
  .superRefine(refineReportCardsV9Response);
export type ReportCardsV9LegacyResponse = z.infer<
  typeof ReportCardsV9LegacyResponseSchema
>;

/** Compatibility reader for report-v2 envelopes carrying causal trace-v2 cards. */
export const ReportCardsV9PreviousResponseSchema = z
  .object({
    ...ReportCardsV9ResponseShape,
    schemaVersion: z.literal(REPORT_CARDS_V9_PREVIOUS_RESPONSE_SCHEMA_VERSION),
    cards: z.array(SafetyScoreV9CausalCardSchema),
  })
  .strict()
  .superRefine(refineReportCardsV9Response);
export type ReportCardsV9PreviousResponse = z.infer<
  typeof ReportCardsV9PreviousResponseSchema
>;

/** Current public report contract. Report-v3 always carries score-adjustment trace-v3 cards. */
export const ReportCardsV9CurrentResponseSchema = z
  .object({
    ...ReportCardsV9ResponseShape,
    schemaVersion: z.literal(REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION),
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

/** Explicit historical reader. Never use this union at a live publication boundary. */
export const ReportCardsV9CompatibleResponseSchema = z.union([
  ReportCardsV9CurrentResponseSchema,
  ReportCardsV9PreviousResponseSchema,
  ReportCardsV9LegacyResponseSchema,
]);
export type ReportCardsV9CompatibleResponse = z.infer<
  typeof ReportCardsV9CompatibleResponseSchema
>;
