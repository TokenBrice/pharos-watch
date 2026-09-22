import { z } from "zod";

export const CacheStatusSchema = z.object({
  ageSeconds: z.number().nullable(),
  maxAge: z.number(),
  healthyMaxRatio: z.number().optional(),
  healthyMaxAge: z.number().optional(),
  healthy: z.boolean(),
  freshnessSource: z.enum(["freshness-sentinel", "table-fallback", "cron-fallback"]).optional(),
  sentinelValidationReason: z.string().nullable().optional(),
  /**
   * Input quality for the generation the freshness verdict describes (rule R3).
   * `degraded` is the producer-run quality, independent of age; `null` where the
   * evidence could not be read. Only sentinel-backed caches publish these.
   */
  degraded: z.boolean().nullable().optional(),
  degradedReason: z.string().nullable().optional(),
  streakDegradedRuns: z.number().nullable().optional(),
  producerJob: z.string().nullable().optional(),
  producerIntervalSec: z.number().nullable().optional(),
  endpointMaxAge: z.number().nullable().optional(),
  availabilityMaxAge: z.number().nullable().optional(),
  endpointBudgetReason: z.string().nullable().optional(),
  availabilityBudgetReason: z.string().nullable().optional(),
  mode: z.enum(["live", "cached-fallback"]).optional(),
  sourceUpdatedAt: z.number().nullable().optional(),
  sourceAgeSeconds: z.number().nullable().optional(),
  sourceStatus: z.enum(["fresh", "degraded", "stale", "none"]).optional(),
  warning: z.string().nullable().optional(),
  consecutiveFallbackRuns: z.number().optional(),
  upstreamProvider: z.string().nullable().optional(),
});

export const StatusHealthValueSchema = z.enum(["healthy", "degraded", "stale"]);
export const StatusHealthOrUnknownSchema = z.enum([...StatusHealthValueSchema.options, "unknown"]);
