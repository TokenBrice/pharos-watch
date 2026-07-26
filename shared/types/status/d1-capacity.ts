import { z } from "zod";

export type D1CapacityThresholdState = "normal" | "watch" | "warning" | "critical";
export type D1CapacityForecastBasis =
  "linear-30d" | "linear-window" | "insufficient-history" | "non-growing";
export type D1CapacityGrowthWindowKey = "24h" | "72h" | "7d" | "30d";

export interface D1CapacityGrowthWindow {
  window: D1CapacityGrowthWindowKey;
  windowSeconds: number;
  sampleCount: number;
  spanHours: number;
  valid: boolean;
  growthBytesPerDay: number | null;
}

export interface D1CapacityAssessment {
  observedAt: number;
  databaseSizeBytes: number;
  maximumSizeBytes: number;
  utilizationRatio: number;
  utilizationPercent: number;
  thresholdState: D1CapacityThresholdState;
  crossedThresholdPercent: 60 | 75 | 90 | null;
  nextThresholdPercent: 60 | 75 | 90 | 100 | null;
  sampleCount: number;
  forecastBasis: D1CapacityForecastBasis;
  forecastSpanHours: number;
  growthBytesPerDay: number | null;
  nextThresholdAt: number | null;
  exhaustionAt: number | null;
  daysUntilExhaustion: number | null;
  /** Additive for compatibility with cached assessments written by older Workers. */
  growthWindows?: D1CapacityGrowthWindow[];
  /** The shortest valid regression window used for the conservative runway. */
  conservativeWindow?: D1CapacityGrowthWindowKey | null;
}

const D1CapacityGrowthWindowSchema: z.ZodType<D1CapacityGrowthWindow> = z.object({
  window: z.enum(["24h", "72h", "7d", "30d"]),
  windowSeconds: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  spanHours: z.number().nonnegative(),
  valid: z.boolean(),
  growthBytesPerDay: z.number().nullable(),
});

export const D1CapacityAssessmentSchema: z.ZodType<D1CapacityAssessment> = z.object({
  observedAt: z.number().int().nonnegative(),
  databaseSizeBytes: z.number().nonnegative(),
  maximumSizeBytes: z.number().positive(),
  utilizationRatio: z.number().nonnegative(),
  utilizationPercent: z.number().nonnegative(),
  thresholdState: z.enum(["normal", "watch", "warning", "critical"]),
  crossedThresholdPercent: z.union([z.literal(60), z.literal(75), z.literal(90)]).nullable(),
  nextThresholdPercent: z.union([z.literal(60), z.literal(75), z.literal(90), z.literal(100)]).nullable(),
  sampleCount: z.number().int().nonnegative(),
  forecastBasis: z.enum(["linear-30d", "linear-window", "insufficient-history", "non-growing"]),
  forecastSpanHours: z.number().nonnegative(),
  growthBytesPerDay: z.number().nullable(),
  nextThresholdAt: z.number().int().nonnegative().nullable(),
  exhaustionAt: z.number().int().nonnegative().nullable(),
  daysUntilExhaustion: z.number().nonnegative().nullable(),
  growthWindows: z.array(D1CapacityGrowthWindowSchema).optional(),
  conservativeWindow: z.enum(["24h", "72h", "7d", "30d"]).nullable().optional(),
}).passthrough();
