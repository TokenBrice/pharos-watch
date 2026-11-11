import { z } from "zod";
import { FreshnessAssessmentSchema } from "@pharos/contracts/api-meta";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

const SignalDetailSchema = z
  .object({
    value: z.number(),
    available: z.boolean(),
  })
  .passthrough();

const AmplifiersSchema = z.object({
  psi: z.number(),
  contagion: z.number(),
});

export const StressSignalAgeClassificationSchema = z.enum(["fresh", "lagging", "stale", "retainedLastValid"]);
export type StressSignalAgeClassification = z.infer<typeof StressSignalAgeClassificationSchema>;

export const StressSignalDataStatusSchema = z.enum(["ok", "degraded", "unavailable"]);
export type StressSignalDataStatus = z.infer<typeof StressSignalDataStatusSchema>;

export const StressSignalDataReasonSchema = z.enum([
  "no-current-rows",
  "no-readable-current-rows",
  "all-current-rows-malformed",
  "single-coin-current-row-missing",
  "current-row-malformed",
  "publication-pointer-unavailable",
  "current-rows-read-failed",
  "computed-count-zero",
  "partial-coverage",
]);
export type StressSignalDataReason = z.infer<typeof StressSignalDataReasonSchema>;

export const StressSignalEntrySchema = FreshnessAssessmentSchema.partial().extend({
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
  ageClassification: StressSignalAgeClassificationSchema.optional(),
  // Null in single-coin mode, where no cross-coin generation comparison is made.
  newestReturnedComputedAt: z.number().nullable().optional(),
});

export type StressSignalEntry = z.infer<typeof StressSignalEntrySchema>;

export const StressSignalsAllResponseSchema = z.object({
  signals: z.record(z.string(), StressSignalEntrySchema),
  updatedAt: z.number(),
  eligibleCount: z.number().int().nonnegative().optional(),
  computedCount: z.number().int().nonnegative().optional(),
  missingCount: z.number().int().nonnegative().optional(),
  oldestComputedAt: z.number().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
  malformedRows: z.number().optional(),
  coverageStatus: StressSignalDataStatusSchema.optional(),
  coverageReasons: z.array(StressSignalDataReasonSchema).optional(),
  methodology: MethodologyEnvelopeSchema,
});

export type StressSignalsAllResponse = z.infer<typeof StressSignalsAllResponseSchema>;

const StressSignalHistoryEntrySchema = z.object({
  date: z.number(),
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  methodologyVersion: z.string(),
});

export const StressSignalDetailResponseSchema = z.object({
  current: StressSignalEntrySchema.nullable(),
  history: z.array(StressSignalHistoryEntrySchema),
  malformedRows: z.number().optional(),
  currentStatus: StressSignalDataStatusSchema.optional(),
  currentReasons: z.array(StressSignalDataReasonSchema).optional(),
  methodology: MethodologyEnvelopeSchema,
});

export type StressSignalDetailResponse = z.infer<typeof StressSignalDetailResponseSchema>;
