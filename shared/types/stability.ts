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
  aggregateUniverse: z.literal("core-stablecoins-v1").optional(),
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

const UsdsImplementationAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid implementation address")
  .transform((value) => value.toLowerCase());

export const UsdsStatusResponseSchema = z
  .object({
    implementationAddress: UsdsImplementationAddressSchema,
    freezeCapabilityPresent: z.unknown().optional(),
    freezeActive: z.unknown().optional(),
    lastChecked: z.unknown().optional(),
  })
  .transform((value) => {
    const freezeCapabilityPresent =
      typeof value.freezeCapabilityPresent === "boolean"
        ? value.freezeCapabilityPresent
        : typeof value.freezeActive === "boolean"
          ? value.freezeActive
          : false;
    return {
      freezeCapabilityPresent,
      // `freezeActive` is intentionally a mirror of `freezeCapabilityPresent`:
      // the only observable on-chain signal is whether the freeze feature exists
      // (isBlocked(address(0)) is true iff the capability is present), not whether
      // any account is currently frozen. Kept as a deprecated alias for backward
      // compatibility; the frontend reads only `freezeCapabilityPresent`. Drop
      // this field if/when real freeze-event detection is added. See audit Q-238.
      freezeActive: freezeCapabilityPresent,
      implementationAddress: value.implementationAddress,
      lastChecked:
        typeof value.lastChecked === "number" && Number.isFinite(value.lastChecked) && value.lastChecked >= 0
          ? Math.floor(value.lastChecked)
          : 0,
    };
  });
export type UsdsStatusResponse = z.infer<typeof UsdsStatusResponseSchema>;
