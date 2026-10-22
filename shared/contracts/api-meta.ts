import { z } from "zod";

const FRESHNESS_STATUS_VALUES = ["fresh", "degraded", "stale"] as const;
export const FreshnessStatusSchema = z.enum(FRESHNESS_STATUS_VALUES);

/**
 * `X-Data-Freshness-Reason` for a Safety Score publication past the V9 consumer budget (one missed
 * publication). It is the scoring fail-close verdict behind `X-Safety-Score-Status: stale`, not a
 * reader staleness claim: reader health ages that publication against its own band (ADR-42).
 */
export const SAFETY_SCORE_PUBLICATION_AGE_REASON = "safety-score-publication-age";

/** Effective age bands and the wall clock at which a freshness verdict was assessed. */
export const FreshnessAssessmentSchema = z.object({
  assessedAt: z.number(),
  freshBudgetSec: z.number().nonnegative(),
  degradedBudgetSec: z.number().nonnegative(),
});

export const ApiDependencyMetaSchema = z.object({
  updatedAt: z.number().nullable().optional(),
  ageSeconds: z.number().nullable().optional(),
  /** Independent consumer budget and accepted generation, not the parent response clock. */
  freshBudgetSec: z.number().finite().nonnegative().optional(),
  generationId: z.string().nullable().optional(),
  status: z.enum([...FRESHNESS_STATUS_VALUES, "unavailable"]),
  reason: z.string().nullish(),
});

export type ApiDependencyMeta = z.output<typeof ApiDependencyMetaSchema>;

// Legacy cached responses and header-only unavailable verdicts may lack the
// assessment; readers preserve that absence rather than inventing policy.
export const ApiMetaSchema = FreshnessAssessmentSchema.partial().extend({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: FreshnessStatusSchema,
  warning: z.string().nullish(),
  dependencies: z.record(z.string(), ApiDependencyMetaSchema).nullish(),
});

export const ApiMetaWarningOnlySchema = z.object({
  status: z.literal("degraded"),
  warning: z.string(),
  updatedAt: z.undefined().optional(),
  ageSeconds: z.undefined().optional(),
  dependencies: z.undefined().optional(),
});

const ApiMetaUnavailableSchema = FreshnessAssessmentSchema.partial().extend({
  updatedAt: z.null(),
  ageSeconds: z.null(),
  status: z.enum(["stale", "unknown"]),
  reason: z.string(),
  warning: z.string().nullish(),
  dependencies: z.record(z.string(), ApiDependencyMetaSchema).nullish(),
});

export const ApiMetaEnvelopeSchema = z.union([
  ApiMetaSchema,
  ApiMetaWarningOnlySchema,
  ApiMetaUnavailableSchema,
]);

export type ApiMeta = z.output<typeof ApiMetaSchema>;
export type ApiMetaEnvelope = z.output<typeof ApiMetaEnvelopeSchema>;
