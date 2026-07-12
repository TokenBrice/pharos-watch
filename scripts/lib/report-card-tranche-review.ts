import { z } from "zod";

export const REPORT_CARD_TRANCHE_RESULTS_ROOT = "agents/safety-score-v9/results/pre-v9/tranches";

const ScoreValueSchema = z.number().finite().min(0).max(100).nullable();

export const ReportCardTrancheReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    tranche: z.string().min(1),
    generatedAt: z.string().datetime(),
    sourceRevision: z.string().min(1),
    artifacts: z.object({
      fixedInput: z.string().min(1),
      baseline: z.string().min(1),
      candidate: z.string().min(1),
      diff: z.string().min(1),
    }),
    methodologyDecision: z.object({
      before: z.string().min(1),
      after: z.string().min(1),
      bumped: z.boolean(),
      rationale: z.string().min(1),
    }),
    movements: z.array(
      z.object({
        id: z.string().min(1),
        score: z.object({ before: ScoreValueSchema, after: ScoreValueSchema }),
        grade: z.object({ before: z.string().min(1), after: z.string().min(1) }),
        disposition: z.enum(["expected", "accepted-secondary", "bug"]),
        rule: z.string().min(1),
        rationale: z.string().min(1),
      }),
    ),
    checks: z.array(
      z.object({
        command: z.string().min(1),
        status: z.enum(["passed", "failed", "not-run"]),
        note: z.string().optional(),
      }),
    ),
    unresolved: z.array(z.string()),
  })
  .strict()
  .superRefine((review, ctx) => {
    const seen = new Set<string>();
    review.movements.forEach((movement, index) => {
      if (seen.has(movement.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate movement review for ${movement.id}`,
          path: ["movements", index, "id"],
        });
      }
      seen.add(movement.id);
    });
  });

export type ReportCardTrancheReview = z.infer<typeof ReportCardTrancheReviewSchema>;

export function parseReportCardTrancheReview(value: unknown): ReportCardTrancheReview {
  const parsed = ReportCardTrancheReviewSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Malformed tranche review at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
  }
  return parsed.data;
}
