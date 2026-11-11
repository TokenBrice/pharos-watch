import { z } from "zod";
import { Sha256Schema } from "./safety-schema-primitives";
import {
  SAFETY_SCORE_V9_CACHE_KEYS,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
} from "./safety-score-cache-keys";

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
  base: z.object({ key: z.literal(SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY), ...cacheRowFields }).strict(),
  delta: z.object({ key: z.literal(SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY), ...cacheRowFields }).strict(),
  cards: z.object({ key: z.literal(SAFETY_SCORE_V9_CACHE_KEYS.publication), ...cacheRowFields }).strict(),
}).strict();

export type SafetyScoreCaptureArchiveObject = z.output<typeof SafetyScoreCaptureArchiveObjectSchema>;
export type SafetyScoreCaptureArchiveCacheRows = Pick<SafetyScoreCaptureArchiveObject, "base" | "delta" | "cards">;
