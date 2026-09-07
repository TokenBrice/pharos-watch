import wrapperAllocationReviewsAsset from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { z } from "zod";

const WrapperAllocationObservationSchema = z
  .object({
    chain: z.string().trim().min(1),
    address: z.string().trim().min(1),
    function: z.string().trim().min(1),
    value: z.string().trim().min(1),
    block: z.number().int().nonnegative(),
  })
  .strict();

export const SafetyScoreV9WrapperAllocationReviewSchema = z
  .object({
    assetId: z.string().trim().min(1),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewer: z.string().trim().min(1),
    custody: z.literal("fully-onchain-no-offchain-custodian"),
    localLeverage: z.enum([
      "no-borrowing-surface",
      "bounded-up-to-1.1x",
      "bounded-up-to-1.5x",
      "bounded-up-to-2x",
      "unbounded-or-above-2x",
    ]),
    capitalReuse: z.enum([
      "none",
      "bluechip-overcollateralized-lending",
      "mixed-overcollateralized-lending",
      "long-tail-overcollateralized-lending",
      "multi-strategy-reuse",
      "liquidation-loss-absorption",
      "single-borrower-risk-capital",
    ]),
    rationale: z.string().trim().min(1),
    observations: z.array(WrapperAllocationObservationSchema).min(1),
    sources: z
      .array(
        z
          .object({
            label: z.string().trim().min(1),
            url: z.string().url(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (Date.parse(`${review.expiresAt}T00:00:00.000Z`) <= Date.parse(`${review.reviewedAt}T00:00:00.000Z`)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Wrapper allocation review must expire after its review date",
      });
    }
  });

const SafetyScoreV9WrapperAllocationReviewFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviews: z.array(SafetyScoreV9WrapperAllocationReviewSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.reviews.forEach((review, index) => {
      if (seen.has(review.assetId)) {
        ctx.addIssue({
          code: "custom",
          path: ["reviews", index, "assetId"],
          message: `Duplicate wrapper allocation review for ${review.assetId}`,
        });
      }
      seen.add(review.assetId);
    });
  });

export type SafetyScoreV9WrapperAllocationReview = z.output<
  typeof SafetyScoreV9WrapperAllocationReviewSchema
>;

const WRAPPER_ALLOCATION_REVIEW_FILE = SafetyScoreV9WrapperAllocationReviewFileSchema.parse(
  wrapperAllocationReviewsAsset,
);

const WRAPPER_ALLOCATION_REVIEWS = new Map(
  WRAPPER_ALLOCATION_REVIEW_FILE.reviews.map((review) => [review.assetId, review]),
);

export function getSafetyScoreV9WrapperAllocationReview(
  assetId: string,
  clockSec: number,
): SafetyScoreV9WrapperAllocationReview | null {
  const review = WRAPPER_ALLOCATION_REVIEWS.get(assetId);
  if (!review) return null;
  const clockMs = clockSec * 1_000;
  return Date.parse(`${review.reviewedAt}T00:00:00.000Z`) <= clockMs &&
    clockMs < Date.parse(`${review.expiresAt}T00:00:00.000Z`)
    ? review
    : null;
}
