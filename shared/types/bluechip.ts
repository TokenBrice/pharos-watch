import { z } from "zod";
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
  // Upstream can omit each of these. They stay nullable so the published contract can say
  // "not reported" instead of forcing the producer to fabricate a rated-looking 0/false.
  collateralization: z.number().nullable(),
  smartContractAudit: z.boolean().nullable(),
  dateOfRating: z.string().nullable(),
  dateLastChange: z.string().nullable(),
  smidge: BluechipSmidgeSchema,
});
export type BluechipRating = z.output<typeof BluechipRatingSchema>;

export const BluechipRatingsMapSchema = z.record(z.string(), BluechipRatingSchema);
export type BluechipRatingsMap = z.output<typeof BluechipRatingsMapSchema>;
