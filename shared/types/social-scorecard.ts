import { z } from "zod";
import { ReportCardGradeSchema } from "./report-card-grade";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import { ScoreSchema, Sha256Schema, UnixSecondsSchema } from "./safety-schema-primitives";

const SubjectIdSchema = z.string().min(1).max(100).regex(/^[a-z0-9](?:[a-z0-9]|-[a-z0-9])*$/);
const SubjectTextSchema = z.string().min(1).max(160).refine((text) => !/\p{Cc}/u.test(text));
const CoinSubjectSchema = z.object({
  kind: z.literal("stablecoin"),
  id: SubjectIdSchema,
  name: SubjectTextSchema,
  symbol: SubjectTextSchema,
  score: ScoreSchema.nullable(),
  grade: ReportCardGradeSchema,
  ratingStatus: z.enum(["rated", "not-rated"]),
}).strict().superRefine((subject, ctx) => {
  if ((subject.ratingStatus === "rated" && (subject.score === null || subject.grade === "NR"))
    || (subject.ratingStatus === "not-rated" && (subject.score !== null || subject.grade !== "NR"))) {
    ctx.addIssue({ code: "custom", message: "Published score and grade must match rating status" });
  }
});
const OverviewSubjectSchema = z.object({
  kind: z.literal("overview"),
  id: z.literal("safety-scores"),
  ratedCount: z.number().int().nonnegative().max(10_000),
  notRatedCount: z.number().int().nonnegative().max(10_000),
  unavailableCount: z.number().int().nonnegative().max(10_000),
  totalCount: z.number().int().positive().max(10_000),
  averageScore: ScoreSchema.nullable(),
}).strict().superRefine((subject, ctx) => {
  if (subject.ratedCount + subject.notRatedCount + subject.unavailableCount !== subject.totalCount
    || (subject.ratedCount === 0) !== (subject.averageScore === null)) {
    ctx.addIssue({ code: "custom", message: "Overview must disclose the complete accepted cohort" });
  }
});

export const SocialScorecardMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  rendererRevision: z.string().min(1).max(64).regex(/^[a-z0-9.-]+$/),
  publication: SafetyScoreV9PublicationIdentitySchema.extend({
    methodologyVersion: z.string().min(1).max(64),
    publicationGenerationId: z.string().min(1).max(256),
    policyId: z.string().min(1).max(128),
  }),
  asOfSec: UnixSecondsSchema,
  publishedAtSec: UnixSecondsSchema,
  freshnessBudgetSec: z.number().int().positive().max(604_800),
  subject: z.union([CoinSubjectSchema, OverviewSubjectSchema]),
  imageSha256: Sha256Schema,
}).strict().superRefine((metadata, ctx) => {
  if (metadata.publishedAtSec < metadata.asOfSec) {
    ctx.addIssue({ code: "custom", message: "Publication cannot predate observation" });
  }
});
export type SocialScorecardMetadata = z.infer<typeof SocialScorecardMetadataSchema>;

export const SocialScorecardCreateSchema = z.object({ stablecoinId: SubjectIdSchema }).strict();
export const SocialScorecardRecordSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: SocialScorecardMetadataSchema,
  imageBase64: z.string().min(1).max(2_796_204).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type SocialScorecardRecord = z.infer<typeof SocialScorecardRecordSchema>;

export interface SealedSocialScorecard {
  id: string;
  record: SocialScorecardRecord;
}

export const SocialScorecardCreatedSchema = z.object({
  url: z.string().url().max(256),
  imageUrl: z.string().url().max(256),
}).strict();
export type SocialScorecardCreated = z.infer<typeof SocialScorecardCreatedSchema>;
