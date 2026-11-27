import { z } from "zod";

/**
 * Frozen shape of the `bluechipMap` field in legacy V3 report-card fixed-input
 * captures. Pharos no longer fetches, scores or serves Bluechip ratings; this
 * schema stays only so archived V3 captures parse, and keep their base-input
 * identity, exactly as before. Do not reuse it for new inputs.
 */
const BluechipGradeSchema = z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);

const BluechipSmidgeSchema = z.object({
  stability: z.string().nullable(),
  management: z.string().nullable(),
  implementation: z.string().nullable(),
  decentralization: z.string().nullable(),
  governance: z.string().nullable(),
  externals: z.string().nullable(),
});

const BluechipRatingSchema = z.object({
  grade: BluechipGradeSchema,
  slug: z.string(),
  // Legacy caches and archived captures have no constituent observation clock.
  lastObservedAt: z.number().int().nonnegative().nullable().default(null),
  observationState: z.enum(["current", "retained", "stale", "unknown"]).default("unknown"),
  observationReason: z.string().nullable().default("legacy-observation-unknown"),
  collateralization: z.number().nullable(),
  smartContractAudit: z.boolean().nullable(),
  dateOfRating: z.string().nullable(),
  dateLastChange: z.string().nullable(),
  smidge: BluechipSmidgeSchema,
});

export const BluechipRatingsMapSchema = z.record(z.string(), BluechipRatingSchema);
