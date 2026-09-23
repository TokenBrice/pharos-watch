import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./core";

/**
 * Closed PSI condition-band vocabulary. Every published band comes from the producer's
 * score thresholds, so the wire contract publishes the closed set rather than a free-form
 * string: consumers that index a band→colour map cannot be handed a value the map lacks.
 */
export const PSI_CONDITION_BAND_VALUES = [
  "BEDROCK",
  "STEADY",
  "TREMOR",
  "FRACTURE",
  "CRISIS",
  "MELTDOWN",
] as const;

export const PsiConditionBandSchema = z.enum(PSI_CONDITION_BAND_VALUES);
export type PsiConditionBand = z.infer<typeof PsiConditionBandSchema>;

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
  /** Open depegs the producer could not price: missing severity input, not zero severity. */
  openDepegNoPrice: z.boolean().optional(),
  openDepegsWithoutPrice: z.number().int().nullable().optional(),
});

export const StabilityIndexCurrentSchema = z.object({
  score: z.number(),
  band: PsiConditionBandSchema,
  avg24h: z.number().optional(),
  avg24hBand: PsiConditionBandSchema.optional(),
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
  band: PsiConditionBandSchema,
  components: StabilityIndexComponentsSchema.optional(),
  methodologyVersion: z.string(),
});

export const StabilityIndexResponseSchema = z.object({
  current: StabilityIndexCurrentSchema.nullable(),
  history: z.array(StabilityIndexHistoryPointSchema),
  /**
   * Number of history rows the route dropped while decoding them. Present on every
   * response that decoded rows; the no-history early return omits it, so the published
   * contract keeps it optional instead of rejecting that valid body.
   */
  malformedRows: z.number().optional(),
  methodology: MethodologyEnvelopeSchema,
});

export type StabilityContributor = z.infer<typeof StabilityContributorSchema>;
export type StabilityIndexCurrent = z.infer<typeof StabilityIndexCurrentSchema>;
export type StabilityIndexResponse = z.infer<typeof StabilityIndexResponseSchema>;

const UsdsImplementationAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid implementation address");

/** Parsed shape of the cached USDS status payload, before the route applies its defaults. */
const UsdsStatusResponseBaseSchema = z.object({
  implementationAddress: UsdsImplementationAddressSchema,
  freezeCapabilityPresent: z.boolean(),
  lastChecked: z.unknown().optional(),
});

export const UsdsStatusResponseSchema = UsdsStatusResponseBaseSchema.transform((value) => {
  return {
    freezeCapabilityPresent: value.freezeCapabilityPresent,
    implementationAddress: value.implementationAddress.toLowerCase(),
    lastChecked:
      typeof value.lastChecked === "number" && Number.isFinite(value.lastChecked) && value.lastChecked >= 0
        ? Math.floor(value.lastChecked)
        : 0,
  };
});
export type UsdsStatusResponse = z.infer<typeof UsdsStatusResponseSchema>;

/**
 * What the route serves, for artifact registries that document responses rather than
 * inputs. Derived from the base above, so a field added there is documented without a
 * second edit; only the fields the transform defaults are restated.
 */
export const UsdsStatusResponseOutputSchema = UsdsStatusResponseBaseSchema.extend({
  lastChecked: z.number(),
});
