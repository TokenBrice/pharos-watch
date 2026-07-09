import { z } from "zod";

export const CacheStatusSchema = z.object({
  ageSeconds: z.number().nullable(),
  maxAge: z.number(),
  healthy: z.boolean(),
  freshnessSource: z.enum(["freshness-sentinel", "table-fallback", "cron-fallback"]).optional(),
  sentinelValidationReason: z.string().nullable().optional(),
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
