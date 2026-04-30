import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./core";

export const StabilityIndexComponentsSchema = z.object({
  severity: z.number(),
  breadth: z.number(),
  stressBreadth: z.number().optional(),
  trend: z.number(),
});

export const StabilityContributorSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number(),
  ageDays: z.number(),
  factor: z.number(),
});

export const StabilityIndexInputDegradationSchema = z.object({
  dewsUnavailable: z.boolean(),
  dewsFailureReason: z.string().nullable(),
  depegEventsUnavailable: z.boolean(),
  depegEventsFailureReason: z.string().nullable(),
});

export const StabilityIndexCurrentSchema = z.object({
  score: z.number(),
  band: z.string(),
  avg24h: z.number().optional(),
  avg24hBand: z.string().optional(),
  components: StabilityIndexComponentsSchema,
  contributors: z.array(StabilityContributorSchema).optional(),
  inputDegradation: StabilityIndexInputDegradationSchema.optional(),
  totalMcapUsd: z.number().optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
});

export const StabilityIndexHistoryPointSchema = z.object({
  date: z.number(),
  score: z.number(),
  band: z.string(),
  components: StabilityIndexComponentsSchema.optional(),
  methodologyVersion: z.string(),
});

export const StabilityIndexResponseSchema = z.object({
  current: StabilityIndexCurrentSchema.nullable(),
  history: z.array(StabilityIndexHistoryPointSchema),
  methodology: MethodologyEnvelopeSchema,
});

export type StabilityContributor = z.infer<typeof StabilityContributorSchema>;
export type StabilityIndexCurrent = z.infer<typeof StabilityIndexCurrentSchema>;
export type StabilityIndexHistoryPoint = z.infer<typeof StabilityIndexHistoryPointSchema>;
export type StabilityIndexResponse = z.infer<typeof StabilityIndexResponseSchema>;
