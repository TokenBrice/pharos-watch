import { z } from "zod";
import { PriceObservedAtModeSchema } from "./price";
import { CanonicalTextSchema, UnixSecondsSchema } from "./safety-schema-primitives";

export const FxReferenceSourceSchema = z.enum([
  "frankfurter", "openExchangeRates", "fawazahmed0", "exchangeRateApi", "chainlink", "gold-api.com", "peer-median",
]);
export const FxSourceCadenceSchema = z.enum(["intraday", "business-daily", "calendar-daily"]);
export type FxSourceCadence = z.output<typeof FxSourceCadenceSchema>;

export const FxReferenceObservationSchema = z.object({
  pegKey: CanonicalTextSchema,
  usdPerUnit: z.number().finite().positive(),
  source: FxReferenceSourceSchema,
  cadence: FxSourceCadenceSchema,
  /** The underlying observation (for ECB, concertation), even when carried into a later publication. */
  observedAtSec: UnixSecondsSchema,
  publishedAtSec: UnixSecondsSchema.optional(),
}).refine((row) => row.publishedAtSec === undefined || row.publishedAtSec >= row.observedAtSec, {
  path: ["publishedAtSec"], message: "Publication precedes observation",
});
export type FxReferenceObservation = z.output<typeof FxReferenceObservationSchema>;
export type FxReferenceObservationMap = Record<FxReferenceObservation["pegKey"], FxReferenceObservation>;

/** A constituent of the selected price, including its asset identity when the producer recorded it. */
export const FxMedianContributorSchema = z.object({
  assetId: CanonicalTextSchema.optional(),
  observedAtMode: PriceObservedAtModeSchema.optional(),
  observedAtSec: UnixSecondsSchema.positive().nullable(),
  provenanceKey: z.string(),
  derivation: z.enum(["traded-market", "nav", "oracle", "spot-derived"]),
});

export const FxRepricingSchema = z.object({
  source: FxReferenceSourceSchema.optional(),
  sessionOpenedAtSec: UnixSecondsSchema.positive(),
  preCloseUsdPerUnit: z.number().finite().positive().nullish(),
  firstInSessionObservedAtSec: UnixSecondsSchema.positive().optional(),
});

export const FxReferenceEvidenceSchema = FxReferenceObservationSchema.safeExtend({
  repricing: FxRepricingSchema.optional(),
  contributors: z.array(FxMedianContributorSchema).optional(),
}).refine(({ source, observedAtSec, repricing }) => !repricing || (
  source !== "peer-median" && (repricing.source === undefined || repricing.source === source) &&
  repricing.sessionOpenedAtSec <= observedAtSec && (repricing.firstInSessionObservedAtSec === undefined ||
    (repricing.firstInSessionObservedAtSec >= repricing.sessionOpenedAtSec && repricing.firstInSessionObservedAtSec <= observedAtSec))
), "Repricing must describe this provider observation and session").refine(({ source, cadence, observedAtSec, contributors }) => {
  if (source !== "peer-median") return contributors === undefined;
  if (cadence !== "intraday") return false;
  if (!contributors?.length) return true;
  const ids = contributors.flatMap(({ assetId }) => assetId === undefined ? [] : [assetId]);
  return new Set(ids).size === ids.length && contributors.every((row) => row.observedAtSec != null && row.observedAtSec >= observedAtSec)
    && contributors.some((row) => row.observedAtSec === observedAtSec);
}, "The median clock and members must describe the selected observation");
export type FxReferenceEvidence = z.output<typeof FxReferenceEvidenceSchema>;

// Isolate a malformed peg without downgrading the generation to a pre-admission publication.
export const FxReferenceEvidenceMapSchema = z.record(z.string(), z.unknown()).transform((rows) => {
  const valid: Record<string, FxReferenceEvidence> = Object.create(null);
  for (const [key, value] of Object.entries(rows)) {
    const row = FxReferenceEvidenceSchema.safeParse(value);
    if (row.success && row.data.pegKey === key) valid[key] = row.data;
  }
  return valid;
});
export type FxReferenceEvidenceMap = z.output<typeof FxReferenceEvidenceMapSchema>;

/** The denominator actually selected from the accepted asset and FX cohort. */
export const SelectedPegReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["fx", "fallback"]),
    generation: CanonicalTextSchema,
    observation: FxReferenceObservationSchema,
    repricing: FxRepricingSchema.optional(),
  }),
  z.object({
    kind: z.literal("median"),
    generation: CanonicalTextSchema,
    pegKey: CanonicalTextSchema,
    usdPerUnit: z.number().finite().positive(),
    contributors: z.array(FxMedianContributorSchema).min(1),
  }),
]).refine((row) => row.kind === "median" || (
  row.observation.source !== "peer-median" && FxReferenceEvidenceSchema.safeParse({ ...row.observation, repricing: row.repricing }).success
), "Direct evidence must describe the selected provider");
export type SelectedPegReference = z.output<typeof SelectedPegReferenceSchema>;
export const SelectedPegReferencesSchema = z.record(z.string(), z.unknown()).transform((rows) => {
  const valid: Record<string, SelectedPegReference> = Object.create(null);
  for (const [key, value] of Object.entries(rows)) {
    const row = SelectedPegReferenceSchema.safeParse(value);
    if (row.success && (row.data.kind === "median" ? row.data.pegKey : row.data.observation.pegKey) === key) {
      valid[key] = row.data;
    }
  }
  return valid;
});
