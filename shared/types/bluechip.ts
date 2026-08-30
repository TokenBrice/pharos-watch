import { z } from "zod";
import type { BluechipGrade } from "./core";
import { BluechipGradeSchema } from "./core";

export const BluechipSmidgeSchema = z.object({
  stability: z.string().nullable(),
  management: z.string().nullable(),
  implementation: z.string().nullable(),
  decentralization: z.string().nullable(),
  governance: z.string().nullable(),
  externals: z.string().nullable(),
});
export type BluechipSmidge = z.output<typeof BluechipSmidgeSchema>;

export const BluechipRatingSchema = z.object({
  grade: BluechipGradeSchema,
  slug: z.string(),
  collateralization: z.number(),
  smartContractAudit: z.boolean(),
  dateOfRating: z.string(),
  dateLastChange: z.string().nullable(),
  smidge: BluechipSmidgeSchema,
});
export type BluechipRating = z.output<typeof BluechipRatingSchema>;

export const BluechipRatingsMapSchema = z.record(z.string(), BluechipRatingSchema);
export type BluechipRatingsMap = z.output<typeof BluechipRatingsMapSchema>;
