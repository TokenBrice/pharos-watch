import { z } from "zod";

export const D1CapacityThresholdStateSchema = z.enum(["normal", "watch", "warning", "critical"]);
export type D1CapacityThresholdState = z.infer<typeof D1CapacityThresholdStateSchema>;

export const D1CapacityForecastBasisSchema = z.enum([
  "linear-30d",
  "linear-window",
  "insufficient-history",
  "non-growing",
]);
export type D1CapacityForecastBasis = z.infer<typeof D1CapacityForecastBasisSchema>;

export const D1CapacityGrowthWindowKeySchema = z.enum(["24h", "72h", "7d", "30d"]);
export type D1CapacityGrowthWindowKey = z.infer<typeof D1CapacityGrowthWindowKeySchema>;

export const D1CapacityGrowthWindowSchema = z.object({
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
}).passthrough();
export type D1CapacityAssessment = z.infer<typeof D1CapacityAssessmentSchema>;
