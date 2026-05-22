import { z } from "zod";
import type { BluechipGrade } from "./core";
import { BluechipGradeSchema } from "./core";

export interface BluechipSmidge {
  stability: string | null;
  management: string | null;
  implementation: string | null;
  decentralization: string | null;
  governance: string | null;
  externals: string | null;
}

export const BluechipSmidgeSchema = z.object({
  stability: z.string().nullable(),
  management: z.string().nullable(),
  implementation: z.string().nullable(),
  decentralization: z.string().nullable(),
  governance: z.string().nullable(),
  externals: z.string().nullable(),
});

export interface BluechipRating {
  grade: BluechipGrade;
  slug: string;
  collateralization: number;
  smartContractAudit: boolean;
  dateOfRating: string;
  dateLastChange: string | null;
  smidge: BluechipSmidge;
}

export const BluechipRatingSchema = z.object({
  grade: BluechipGradeSchema,
  slug: z.string(),
  collateralization: z.number(),
  smartContractAudit: z.boolean(),
  dateOfRating: z.string(),
  dateLastChange: z.string().nullable(),
  smidge: BluechipSmidgeSchema,
});

export type BluechipRatingsMap = Record<string, BluechipRating>;
export const BluechipRatingsMapSchema = z.record(z.string(), BluechipRatingSchema);
