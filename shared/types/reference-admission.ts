import { z } from "zod";
import { FxMedianContributorSchema, FxReferenceSourceSchema, FxSourceCadenceSchema } from "./fx-reference";
import { CanonicalTextSchema, UnixSecondsSchema } from "./safety-schema-primitives";

export const ReferenceKindSchema = z.enum(["fx", "median", "fallback", "none"]);
export const ReferenceContributorSchema = FxMedianContributorSchema;
export type ReferenceContributor = z.output<typeof ReferenceContributorSchema>;

const BudgetSchema = z.number().int().nonnegative();
const EvidenceSchema = z.object({
  kind: ReferenceKindSchema,
  source: FxReferenceSourceSchema.nullable(),
  cadence: FxSourceCadenceSchema.nullable(),
  referenceObservedAtSec: UnixSecondsSchema.nullable(),
  quoteObservedAtSec: UnixSecondsSchema.nullable(),
  decisionAtSec: UnixSecondsSchema,
  budgetSec: BudgetSchema.nullable(),
  sessionOpenedAtSec: UnixSecondsSchema.nullable(),
  generation: CanonicalTextSchema.nullable(),
  policyVersion: z.number().int().positive(),
});

export const ReferenceAdmissionSchema = z.discriminatedUnion("status", [
  EvidenceSchema.extend({
    status: z.literal("admitted"),
    reason: z.enum(["live-reference", "closed-session-traded-median", "daily-fixing-above-band", "closure-move-above-band", "severe-deviation"]),
    kind: ReferenceKindSchema.exclude(["none"]),
    source: FxReferenceSourceSchema,
    cadence: FxSourceCadenceSchema,
    referenceObservedAtSec: UnixSecondsSchema.positive(),
    quoteObservedAtSec: UnixSecondsSchema.positive(),
    budgetSec: BudgetSchema,
  }).refine((row) => row.referenceObservedAtSec <= row.decisionAtSec && row.quoteObservedAtSec <= row.decisionAtSec,
    "Admitted observations must exist at decision time"),
  EvidenceSchema.extend({
    status: z.literal("held-closed-session"),
    reason: z.literal("reference-market-closed"),
  }),
  EvidenceSchema.extend({
    status: z.literal("stale-reference"),
    reason: z.enum([
      "reference-before-reopen", "quote-before-reopen", "reference-over-budget", "quote-over-budget", "quote-reference-unpaired",
      "reference-not-repriced", "daily-fixing-only",
    ]),
  }),
  EvidenceSchema.extend({
    status: z.literal("unavailable"),
    reason: z.enum(["no-reference", "reference-clock-unavailable", "quote-clock-unavailable", "insufficient-contributors", "invalid-reference"]),
  }),
]);
export type ReferenceAdmission = z.output<typeof ReferenceAdmissionSchema>;

const RawDeviationBpsSchema = z.number().finite().brand<"RawDeviationBps">();
export type RawDeviationBps = z.output<typeof RawDeviationBpsSchema>;

/** Tag an unrounded deviation before applying admission or a severity boundary. */
export function asRawDeviationBps(value: number): RawDeviationBps {
  return RawDeviationBpsSchema.parse(value);
}

export const AdmittedDeviationBpsSchema = z.number().finite().nullable();
export type AdmittedDeviationBps = z.output<typeof AdmittedDeviationBpsSchema>;
