import { z } from "zod";
import { canonicalArrayBy } from "./safety-score-v9-fact-primitives";
import {
  V9OperationalResilienceClaimConfidenceSchema,
  V9OperationalResilienceIncidentSchema,
  V9OperationalResilienceLatestAssuranceSchema,
  V9OperationalResilienceReconciliationProceduresSchema,
  V9OperationalResilienceReportHistorySchema,
  V9OperationalResilienceStressEpisodeSchema,
  V9OperationalResilienceStressSettlementSchema,
} from "./safety-score-v9-operational-resilience-primitives";
import { CanonicalTextSchema, StrictIsoDateSchema, UnixSecondsSchema } from "./safety-schema-primitives";

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const IsoDateSchema = StrictIsoDateSchema;

const EvidenceRefIdsSchema = canonicalArrayBy(CanonicalTextSchema, (value) => value).refine(
  (values) => values.length > 0,
  "Operational-resilience claims require evidence",
);

export type { V9OperationalResilienceClaimConfidence } from "./safety-score-v9-operational-resilience-primitives";

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
    settlement: V9OperationalResilienceStressSettlementSchema,
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

const V9OperationalResilienceStressEpisodeFactSchema = V9OperationalResilienceStressEpisodeSchema.extend(
  ClaimEvidenceFields,
).strict();

const V9OperationalResilienceReportHistoryFactSchema = V9OperationalResilienceReportHistorySchema.extend(
  ClaimEvidenceFields,
).strict();

const V9OperationalResilienceLatestAssuranceFactSchema = V9OperationalResilienceLatestAssuranceSchema.extend(
  ClaimEvidenceFields,
).strict();

const V9OperationalResilienceReconciliationProceduresFactSchema =
  V9OperationalResilienceReconciliationProceduresSchema.extend(ClaimEvidenceFields).strict();

const V9OperationalResilienceReserveReconciliationFactSchema = z
  .object({
    reportHistory: V9OperationalResilienceReportHistoryFactSchema,
    latestAssurance: V9OperationalResilienceLatestAssuranceFactSchema,
    latestReconciliationProcedures: V9OperationalResilienceReconciliationProceduresFactSchema,
  })
  .strict();

const V9OperationalResilienceIncidentFactSchema = V9OperationalResilienceIncidentSchema.extend(
  ClaimEvidenceFields,
).strict();

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
