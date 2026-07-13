import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);

/** Exact identity shared by every canonical Safety Score V8 projection. */
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
