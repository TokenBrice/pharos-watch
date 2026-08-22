import { z } from "zod";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

export const PUBLIC_SNAPSHOT_ENVELOPE_VERSION = 2 as const;

const SnapshotDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const UnknownRecordSchema = z.record(z.string(), z.unknown());

const PublicSnapshotStablecoinSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    symbol: z.string(),
    pegType: z.string(),
    pegMechanism: z.string(),
    price: z.number().finite().nullable(),
    circulating: z.record(z.string(), z.number().finite()),
    chains: z.array(z.string()),
    mechanismArchetype: z.string().nullable().optional(),
    pegReferenceId: z.string().nullable().optional(),
    jurisdiction: z
      .object({ country: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const PublicSnapshotPsiSchema = z
  .object({
    computedAt: z.number().int().nonnegative(),
    score: z.number().finite(),
    band: z.string(),
    components: UnknownRecordSchema.nullable(),
    methodologyVersion: z.string(),
  })
  .passthrough();

const PublicSnapshotDewsRowSchema = z
  .object({
    stablecoinId: z.string().min(1),
    computedAt: z.number().int().nonnegative(),
    score: z.number().finite(),
    band: z.string(),
    signals: UnknownRecordSchema.nullable(),
  })
  .passthrough();

const PublicSnapshotLiquidityRowSchema = z
  .object({
    stablecoinId: z.string().min(1),
    totalTvlUsd: z.number().finite().nullable(),
    totalVolume24hUsd: z.number().finite().nullable(),
    poolCount: z.number().int().nonnegative().nullable(),
    liquidityScore: z.number().finite().nullable(),
    durabilityScore: z.number().finite().nullable(),
    coverageClass: z.string().nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .passthrough();

const PublicSnapshotEnvelopeFields = {
  snapshotDate: SnapshotDateSchema,
  generatedAt: z.number().int().nonnegative(),
  methodologyVersions: z.record(z.string(), z.string()),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema,
  stablecoins: z.array(PublicSnapshotStablecoinSchema),
  fxFallbackRates: z.record(z.string(), z.number().finite()).nullable(),
  reportCards: UnknownRecordSchema,
  psi: PublicSnapshotPsiSchema,
  dews: z.array(PublicSnapshotDewsRowSchema),
  liquidity: z.array(PublicSnapshotLiquidityRowSchema),
};

/** Contract written by the current public-snapshot producer. */
export const PublicSnapshotEnvelopeV2Schema = z
  .object({
    version: z.literal(PUBLIC_SNAPSHOT_ENVELOPE_VERSION),
    ...PublicSnapshotEnvelopeFields,
  })
  .strict();
export type PublicSnapshotEnvelopeV2 = z.infer<typeof PublicSnapshotEnvelopeV2Schema>;

/**
 * Explicit compatibility contract for immutable rows written before envelope
 * versioning. Those rows had no `version` field, and the API historically
 * treated every envelope field as optional before applying route-level checks.
 */
export const LegacyPublicSnapshotEnvelopeV1Schema = z
  .object({
    version: z.undefined().optional(),
    snapshotDate: PublicSnapshotEnvelopeFields.snapshotDate.optional(),
    generatedAt: PublicSnapshotEnvelopeFields.generatedAt.optional(),
    methodologyVersions: PublicSnapshotEnvelopeFields.methodologyVersions.optional(),
    safetyScoreIdentity: z.unknown().optional(),
    stablecoins: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
    fxFallbackRates: PublicSnapshotEnvelopeFields.fxFallbackRates.optional(),
    reportCards: z.unknown().optional(),
    psi: z.unknown().optional(),
    dews: z.array(z.object({ stablecoinId: z.string().min(1) }).passthrough()).optional(),
    liquidity: z.array(z.object({ stablecoinId: z.string().min(1) }).passthrough()).optional(),
  })
  .passthrough();
export type LegacyPublicSnapshotEnvelopeV1 = z.infer<typeof LegacyPublicSnapshotEnvelopeV1Schema>;

/** Reader/parser contract for both current v2 envelopes and immutable v1 rows. */
export const PublicSnapshotEnvelopeSchema = z.union([
  PublicSnapshotEnvelopeV2Schema,
  LegacyPublicSnapshotEnvelopeV1Schema,
]);
export type PublicSnapshotEnvelope = z.infer<typeof PublicSnapshotEnvelopeSchema>;
