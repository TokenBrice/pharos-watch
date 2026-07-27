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
