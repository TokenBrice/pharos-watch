import { z } from "zod";

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
const UnixSecondsSchema = z.number().int().nonnegative();
const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Value must be a valid ISO calendar date");

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalArrayBy<T>(schema: z.ZodType<T>, keyOf: (value: T) => string) {
  return z
    .array(schema)
    .superRefine((values, ctx) => {
      const keys = values.map(keyOf);
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate !== undefined) {
        ctx.addIssue({ code: "custom", message: `Duplicate canonical key: ${duplicate}` });
      }
    })
    .transform((values) => [...values].sort((left, right) => compareText(keyOf(left), keyOf(right))));
}

const EvidenceRefIdsSchema = canonicalArrayBy(CanonicalTextSchema, (value) => value).refine(
  (values) => values.length > 0,
  "Operational-resilience claims require evidence",
);

export const V9OperationalResilienceClaimConfidenceSchema = z.enum([
  "issuer-reported",
  "independent-assurance",
  "audited",
  "unknown",
]);
export type V9OperationalResilienceClaimConfidence = z.infer<
  typeof V9OperationalResilienceClaimConfidenceSchema
>;

const ClaimEvidenceFields = {
  evidenceRefIds: EvidenceRefIdsSchema,
  confidence: V9OperationalResilienceClaimConfidenceSchema,
};

const V9OperationalResilienceLiveHistoryFactSchema = z
  .object({
    minimumLiveHistoryMonths: z.number().int().nonnegative(),
    observedAtSec: UnixSecondsSchema,
    treatment: z.literal("eligibility-only"),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceRatioClaimSchema = z
  .object({
    value: NonNegativeFiniteSchema,
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceRedemptionStressWindowFactSchema = z
  .object({
    episodeKey: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    maximumWindowDays: z.number().int().positive(),
    redeemedUsdLowerBound: NonNegativeFiniteSchema,
    redeemedSupplyRatioLowerBound: NonNegativeFiniteSchema,
    settlement: z.discriminatedUnion("state", [
      z
        .object({
          state: z.enum(["settled-in-full", "not-settled-in-full"]),
          verification: z.enum(["issuer-reported", "independently-verified"]),
        })
        .strict(),
      z.object({ state: z.literal("unknown") }).strict(),
    ]),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceRedemptionFactSchema = z
  .object({
    cumulativeLifetimeRedeemedSupplyRatio: V9OperationalResilienceRatioClaimSchema.nullable(),
    stressWindows: canonicalArrayBy(
      V9OperationalResilienceRedemptionStressWindowFactSchema,
      (window) => window.episodeKey,
    ),
  })
  .strict();

const V9OperationalResilienceStressEpisodeFactSchema = z
  .object({
    episodeKey: CanonicalTextSchema,
    name: CanonicalTextSchema,
    observedMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    redemptionContinued: z.boolean().nullable(),
    recoveredWithinSec: NonNegativeFiniteSchema.nullable(),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceReportHistoryFactSchema = z
  .object({
    firstReportPeriodEnd: IsoDateSchema,
    latestReportPeriodEnd: IsoDateSchema,
    observedReportHistoryMonths: z.number().int().nonnegative(),
    reportedCadence: z.enum(["monthly", "quarterly", "semi-annual", "annual", "ad-hoc"]),
    continuityEvidence: z.enum(["issuer-reported", "independently-verified", "unknown"]),
    missedMaterialPeriods: z.number().int().nonnegative().nullable(),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceLatestAssuranceFactSchema = z
  .object({
    level: z.enum(["limited-assurance", "reasonable-assurance", "audit"]),
    standard: CanonicalTextSchema,
    periodEnd: IsoDateSchema,
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceReconciliationProceduresFactSchema = z
  .object({
    bankAndDepositaryBalances: z.boolean().nullable(),
    blockchainAssetsAndLiabilities: z.boolean().nullable(),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceReserveReconciliationFactSchema = z
  .object({
    reportHistory: V9OperationalResilienceReportHistoryFactSchema,
    latestAssurance: V9OperationalResilienceLatestAssuranceFactSchema,
    latestReconciliationProcedures: V9OperationalResilienceReconciliationProceduresFactSchema,
  })
  .strict();

const V9OperationalResilienceIncidentFactSchema = z
  .object({
    incidentKey: CanonicalTextSchema,
    name: CanonicalTextSchema,
    category: z.enum(["redemption", "reserve", "custody", "control", "assurance"]),
    state: z.enum(["active", "resolved"]),
    occurredAt: IsoDateSchema,
    resolvedAt: IsoDateSchema.nullable(),
    ...ClaimEvidenceFields,
  })
  .strict();

const V9OperationalResilienceIncidentReviewFactSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-reviewed") }).strict(),
  z
    .object({
      state: z.literal("reviewed"),
      windowStart: IsoDateSchema,
      windowEnd: IsoDateSchema,
      evidenceRefIds: EvidenceRefIdsSchema,
      confidence: V9OperationalResilienceClaimConfidenceSchema,
      incidents: canonicalArrayBy(
        V9OperationalResilienceIncidentFactSchema,
        (incident) => incident.incidentKey,
      ),
    })
    .strict(),
]);

/**
 * Policy-independent operational evidence. Eligibility-only history is retained
 * for auditability but is not a scoring credit. Unknown review outcomes remain
 * nullable or explicitly `not-reviewed`; the compiler does not coerce them.
 */
export const V9OperationalResilienceFactSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedAtSec: UnixSecondsSchema,
    expiresAtSec: UnixSecondsSchema,
    liveHistoryEligibility: V9OperationalResilienceLiveHistoryFactSchema,
    redemptionThroughput: V9OperationalResilienceRedemptionFactSchema.nullable(),
    stressEpisodes: canonicalArrayBy(
      V9OperationalResilienceStressEpisodeFactSchema,
      (episode) => episode.episodeKey,
    ),
    reserveReconciliation: V9OperationalResilienceReserveReconciliationFactSchema.nullable(),
    incidentReview: V9OperationalResilienceIncidentReviewFactSchema,
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.expiresAtSec <= fact.reviewedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAtSec"],
        message: "Operational-resilience facts must expire after their review",
      });
    }
    const episodeKeys = new Set(fact.stressEpisodes.map((episode) => episode.episodeKey));
    for (const [index, window] of (fact.redemptionThroughput?.stressWindows ?? []).entries()) {
      if (!episodeKeys.has(window.episodeKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["redemptionThroughput", "stressWindows", index, "episodeKey"],
          message: "A redemption stress window must reference a compiled stress episode",
        });
      }
    }
  });

export type V9OperationalResilienceFact = z.infer<typeof V9OperationalResilienceFactSchema>;
