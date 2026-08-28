import { z } from "zod";
import { CanonicalTextSchema, StrictIsoDateSchema } from "./safety-schema-primitives";

export const V9OperationalResilienceSourceConfidenceSchema = z.enum([
  "issuer-reported",
  "independent-assurance",
  "audited",
]);

export const V9OperationalResilienceClaimConfidenceSchema = z.enum([
  "issuer-reported",
  "independent-assurance",
  "audited",
  "unknown",
]);

const V9OperationalResilienceStressSettlementStateSchema = z.enum([
  "settled-in-full",
  "not-settled-in-full",
  "unknown",
]);

const V9OperationalResilienceStressSettlementVerificationSchema = z.enum([
  "issuer-reported",
  "independently-verified",
]);

export const V9OperationalResilienceStressSettlementSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: V9OperationalResilienceStressSettlementStateSchema.exclude(["unknown"]),
      verification: V9OperationalResilienceStressSettlementVerificationSchema,
    })
    .strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);

const V9OperationalResilienceReportedCadenceSchema = z.enum([
  "monthly",
  "quarterly",
  "semi-annual",
  "annual",
  "ad-hoc",
]);

const V9OperationalResilienceContinuityEvidenceSchema = z.enum([
  "issuer-reported",
  "independently-verified",
  "unknown",
]);

const V9OperationalResilienceAssuranceLevelSchema = z.enum([
  "limited-assurance",
  "reasonable-assurance",
  "audit",
]);

export const V9OperationalResilienceIncidentCategorySchema = z.enum([
  "redemption",
  "reserve",
  "custody",
  "control",
  "assurance",
]);

export const V9OperationalResilienceIncidentStateSchema = z.enum(["active", "resolved"]);

/** Shared claim fields; source IDs/evidence IDs remain representation adapters. */
export const V9OperationalResilienceStressEpisodeSchema = z
  .object({
    episodeKey: CanonicalTextSchema,
    name: CanonicalTextSchema,
    observedMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    redemptionContinued: z.boolean().nullable(),
    recoveredWithinSec: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const V9OperationalResilienceReportHistorySchema = z
  .object({
    firstReportPeriodEnd: StrictIsoDateSchema,
    latestReportPeriodEnd: StrictIsoDateSchema,
    observedReportHistoryMonths: z.number().int().nonnegative(),
    reportedCadence: V9OperationalResilienceReportedCadenceSchema,
    continuityEvidence: V9OperationalResilienceContinuityEvidenceSchema,
    missedMaterialPeriods: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const V9OperationalResilienceLatestAssuranceSchema = z
  .object({
    level: V9OperationalResilienceAssuranceLevelSchema,
    standard: CanonicalTextSchema,
    periodEnd: StrictIsoDateSchema,
  })
  .strict();

export const V9OperationalResilienceReconciliationProceduresSchema = z
  .object({
    bankAndDepositaryBalances: z.boolean().nullable(),
    blockchainAssetsAndLiabilities: z.boolean().nullable(),
  })
  .strict();

export const V9OperationalResilienceIncidentSchema = z
  .object({
    incidentKey: CanonicalTextSchema,
    name: CanonicalTextSchema,
    category: V9OperationalResilienceIncidentCategorySchema,
    state: V9OperationalResilienceIncidentStateSchema,
    occurredAt: StrictIsoDateSchema,
    resolvedAt: StrictIsoDateSchema.nullable(),
  })
  .strict();

export type V9OperationalResilienceClaimConfidence = z.infer<
  typeof V9OperationalResilienceClaimConfidenceSchema
>;
