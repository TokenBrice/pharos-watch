import { z } from "zod";

const FRESHNESS_STATUS_VALUES = ["fresh", "degraded", "stale"] as const;
export const FreshnessStatusSchema = z.enum(FRESHNESS_STATUS_VALUES);

/** Effective age bands and the wall clock at which a freshness verdict was assessed. */
export const FreshnessAssessmentSchema = z.object({
  assessedAt: z.number(),
  freshBudgetSec: z.number().nonnegative(),
  degradedBudgetSec: z.number().nonnegative(),
});

export const ApiDependencyMetaSchema = z.object({
  updatedAt: z.number().nullable().optional(),
  ageSeconds: z.number().nullable().optional(),
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
