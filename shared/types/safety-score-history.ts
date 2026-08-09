import { z } from "zod";
import { ReportCardGradeSchema } from "./report-card-grade";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

const SafetyScoreHistoryPointSchema = z.object({
  date: z.number(),
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  prevGrade: ReportCardGradeSchema.nullable(),
  prevScore: z.number().nullable(),
  methodologyVersion: z.string(),
});
export type SafetyScoreHistoryPoint = z.infer<typeof SafetyScoreHistoryPointSchema>;

export const SafetyScoreHistoryResponseSchema = z.array(SafetyScoreHistoryPointSchema);
export type SafetyScoreHistoryResponse = z.infer<typeof SafetyScoreHistoryResponseSchema>;

export const SafetyScoreHistoryV2TransitionKindSchema = z.enum([
  "initial-baseline",
  "organic-grade-change",
  "methodology-boundary-baseline",
  "rollback-baseline",
  "restoration-baseline",
]);
export type SafetyScoreHistoryV2TransitionKind = z.infer<typeof SafetyScoreHistoryV2TransitionKindSchema>;

const SafetyScoreHistoryV2PointSchema = z.object({
  date: z.number(),
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  prevGrade: ReportCardGradeSchema.nullable(),
  prevScore: z.number().nullable(),
  transitionKind: SafetyScoreHistoryV2TransitionKindSchema,
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema,
});
export type SafetyScoreHistoryV2Point = z.infer<typeof SafetyScoreHistoryV2PointSchema>;

/** Versioned, boundary-aware history. The legacy array remains V8-compatible. */
export const SafetyScoreHistoryV2ResponseSchema = z.object({
  schemaVersion: z.literal(2),
  history: z.array(SafetyScoreHistoryV2PointSchema),
});
export type SafetyScoreHistoryV2Response = z.infer<typeof SafetyScoreHistoryV2ResponseSchema>;
