import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import {
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9DependencySummarySchema,
  SafetyScoreV9PillarSchema,
} from "./safety-score-v9-public";
import { V9GradeSchema } from "./safety-score-v9";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const V9SelectorRowSchema = z
  .object({
    id: z.string().min(1),
    safetyScore: z.number().finite().min(0).max(100).nullable(),
    safetyGrade: V9GradeSchema,
    pillars: z
      .object({
        backing: SafetyScoreV9PillarSchema,
        exit: SafetyScoreV9PillarSchema,
        control: SafetyScoreV9PillarSchema,
      })
      .strict(),
    accessPosture: SafetyScoreV9AccessPostureSchema,
    dependencies: SafetyScoreV9DependencySummarySchema,
  })
  .strict();
export type V9SelectorRow = z.infer<typeof V9SelectorRowSchema>;

/**
 * Immutable dark V9 selector projection. It carries no recommendations until
 * the V9 grade floors and numeric recommendation rules are reviewed.
 */
export const V9SelectorSnapshotSchema = z
  .object({
    model: z.literal("v9"),
    schemaVersion: z.literal(1),
    safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
    sourceUpdatedAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    rows: z.array(V9SelectorRowSchema),
    datasetHash: Sha256Schema,
    recommendation: z
      .object({
        status: z.literal("deferred"),
        reason: z.literal("v9-selector-thresholds-unreviewed"),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = snapshot.rows.map((row) => row.id);
    if (
      new Set(ids).size !== ids.length ||
      !ids.every((id, index) => index === 0 || ids[index - 1]! < id)
    ) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: "V9 selector rows must be unique and sorted" });
    }
  });
export type V9SelectorSnapshot = z.infer<typeof V9SelectorSnapshotSchema>;
