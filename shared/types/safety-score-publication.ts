import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);

/**
 * Persisted identity for the retired V8 projection and the compatible private
 * fixed-input format still consumed by the V9 compiler.
 */
export const SafetyScoreV8PublicationIdentitySchema = z
  .object({
    model: z.literal("v8"),
    schemaVersion: z.literal(1),
    methodologyVersion: z.string().trim().min(1),
    evaluationBuildDigest: Sha256Schema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    publicationGenerationId: z.string().trim().min(1),
  })
  .strict();

export type SafetyScoreV8PublicationIdentity = z.infer<typeof SafetyScoreV8PublicationIdentitySchema>;

/**
 * Identity of the private native V9 input capture (schema v4 payload carried in
 * envelope v2). It is deliberately not part of the published
 * `SafetyScorePublicationIdentity` union: no public artifact ever carries it.
 *
 * `evaluationBuildDigest` binds the capture to the pinned V9 evaluation build,
 * so a capture prepared under one evaluator can never be consumed by another.
 *
 * `baseInputGenerationId` keeps the `report-cards-input:v1:` prefix. That prefix
 * is a published format namespace — the public fact-set schemas, the OpenAPI
 * spec, the publication codec, and the `safety_score_history_v2` CHECK all pin
 * it — not a projection version. Which projection produced an id is carried by
 * this identity (`model` + `schemaVersion` + `evaluationBuildDigest`), and ids
 * cannot collide across projections because they are sha256 over content.
 */
export const SafetyScoreV9InputIdentitySchema = z
  .object({
    model: z.literal("v9-input"),
    schemaVersion: z.literal(1),
    methodologyVersion: z.string().trim().min(1),
    evaluationBuildDigest: Sha256Schema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    publicationGenerationId: z.string().trim().min(1),
  })
  .strict();

export type SafetyScoreV9InputIdentity = z.infer<typeof SafetyScoreV9InputIdentitySchema>;

/** Exact identity required for an active Safety Score V9 publication. */
export const SafetyScoreV9PublicationIdentitySchema = z
  .object({
    model: z.literal("v9"),
    schemaVersion: z.literal(1),
    methodologyVersion: z.string().trim().min(1),
    policyId: z.string().trim().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    publicationGenerationId: z.string().trim().min(1),
  })
  .strict();

export type SafetyScoreV9PublicationIdentity = z.infer<typeof SafetyScoreV9PublicationIdentitySchema>;

/**
 * Model-neutral identity for persisted consumers. Historical V8 artifacts
 * retain their original discriminator.
 */
export const SafetyScorePublicationIdentitySchema = z.discriminatedUnion("model", [
  SafetyScoreV8PublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema,
]);

export type SafetyScorePublicationIdentity = z.infer<typeof SafetyScorePublicationIdentitySchema>;
