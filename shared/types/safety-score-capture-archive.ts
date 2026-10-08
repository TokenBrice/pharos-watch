import { z } from "zod";
import { Sha256Schema } from "./safety-schema-primitives";

const cacheRowFields = {
  value: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
};

/** Exact cache transports committed by one accepted Safety publication. */
export const SafetyScoreCaptureArchiveObjectSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().min(1),
  publishedAt: z.number().int().nonnegative(),
  methodologyVersion: z.string().min(1),
  policyDigest: Sha256Schema,
  evaluationBuildDigest: Sha256Schema,
  base: z.object({ key: z.literal("report-cards:v9:accepted-replay-base:v1"), ...cacheRowFields }).strict(),
  delta: z.object({ key: z.literal("report-cards:v9:accepted-replay:v1"), ...cacheRowFields }).strict(),
  cards: z.object({ key: z.literal("report-cards:v9"), ...cacheRowFields }).strict(),
}).strict();

export type SafetyScoreCaptureArchiveObject = z.output<typeof SafetyScoreCaptureArchiveObjectSchema>;
export type SafetyScoreCaptureArchiveCacheRows = Pick<SafetyScoreCaptureArchiveObject, "base" | "delta" | "cards">;
