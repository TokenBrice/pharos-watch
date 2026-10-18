import { z } from "zod";

const D1CapacityThresholdStateSchema = z.enum(["normal", "watch", "warning", "critical"]);
export type D1CapacityThresholdState = z.infer<typeof D1CapacityThresholdStateSchema>;

const D1CapacityForecastBasisSchema = z.enum([
  "linear-30d",
  "linear-window",
  "insufficient-history",
  "non-growing",
]);

const D1CapacityHourlyMinMaxSchema = z.object({
  windowSeconds: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  minDatabaseSizeBytes: z.number().nonnegative(),
  maxDatabaseSizeBytes: z.number().nonnegative(),
  swingBytes: z.number().nonnegative(),
});

const D1QuotaThresholdStateSchema = z.enum(["normal", "watch", "warning", "unavailable"]);
export type D1QuotaThresholdState = z.infer<typeof D1QuotaThresholdStateSchema>;

const D1QuotaMetricSchema = z.object({
  observed24h: z.number().nonnegative().nullable(),
  projectedMonthly: z.number().nonnegative().nullable(),
  includedMonthlyAllowance: z.number().positive(),
  /** Null when the trailing-24h observation is unavailable; never a fabricated zero. */
  utilizationPercent: z.number().nonnegative().nullable(),
  thresholdState: D1QuotaThresholdStateSchema,
  crossedThresholdPercent: z.union([z.literal(80), z.literal(95)]).nullable(),
  nextThresholdPercent: z.union([z.literal(80), z.literal(95)]).nullable(),
});
export type D1QuotaMetric = z.infer<typeof D1QuotaMetricSchema>;

export const D1QuotaAssessmentSchema = z.object({
  rowsRead: D1QuotaMetricSchema,
  rowsWritten: D1QuotaMetricSchema,
});
export type D1QuotaAssessment = z.infer<typeof D1QuotaAssessmentSchema>;

const D1CapacityGrowthWindowKeySchema = z.enum(["24h", "72h", "7d", "30d"]);
export type D1CapacityGrowthWindowKey = z.infer<typeof D1CapacityGrowthWindowKeySchema>;

const D1CapacityGrowthWindowSchema = z.object({
  window: D1CapacityGrowthWindowKeySchema,
  windowSeconds: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  spanHours: z.number().nonnegative(),
  valid: z.boolean(),
  growthBytesPerDay: z.number().nullable(),
});
export type D1CapacityGrowthWindow = z.infer<typeof D1CapacityGrowthWindowSchema>;

export const D1CapacityAssessmentSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  databaseSizeBytes: z.number().nonnegative(),
  maximumSizeBytes: z.number().positive(),
  utilizationRatio: z.number().nonnegative(),
  utilizationPercent: z.number().nonnegative(),
  thresholdState: D1CapacityThresholdStateSchema,
  crossedThresholdPercent: z.union([z.literal(60), z.literal(75), z.literal(90)]).nullable(),
  nextThresholdPercent: z.union([z.literal(60), z.literal(75), z.literal(90), z.literal(100)]).nullable(),
  sampleCount: z.number().int().nonnegative(),
  forecastBasis: D1CapacityForecastBasisSchema,
  forecastSpanHours: z.number().nonnegative(),
  growthBytesPerDay: z.number().nullable(),
  nextThresholdAt: z.number().int().nonnegative().nullable(),
  exhaustionAt: z.number().int().nonnegative().nullable(),
  daysUntilExhaustion: z.number().nonnegative().nullable(),
  growthWindows: z.array(D1CapacityGrowthWindowSchema).optional(),
  conservativeWindow: D1CapacityGrowthWindowKeySchema.nullable().optional(),
  /** Optional while an older cached assessment predates retained hourly extremes. */
  hourlyMinMax24h: D1CapacityHourlyMinMaxSchema.optional(),
}).passthrough();
export type D1CapacityAssessment = z.infer<typeof D1CapacityAssessmentSchema>;
