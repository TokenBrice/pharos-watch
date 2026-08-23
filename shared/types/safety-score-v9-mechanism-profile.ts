import { z } from "zod";

export const V9MechanismProfileQualitySchema = z.enum(["strong", "adequate", "limited", "weak", "failed"]);

export const V9MechanismProfileFactSchema = z.union([
  z.object({ disposition: z.literal("supported"), quality: V9MechanismProfileQualitySchema }).strict(),
  z.object({ disposition: z.enum(["issuer-undisclosed", "integration-missing", "method-unsupported"]) }).strict(),
]);

const AllocatedCommodityFactsSchema = z
  .object({
    holderTitle: V9MechanismProfileFactSchema,
    physicalAllocation: V9MechanismProfileFactSchema,
    custodianSegregation: V9MechanismProfileFactSchema,
    bankruptcyRemoteness: V9MechanismProfileFactSchema,
    custodyContinuity: V9MechanismProfileFactSchema,
    auditCadence: V9MechanismProfileFactSchema,
    reserveReconciliation: V9MechanismProfileFactSchema,
    insurance: V9MechanismProfileFactSchema,
    physicalRedemption: V9MechanismProfileFactSchema,
  })
  .strict();

const InflationIndexFactsSchema = z
  .object({
    collateralCoverage: V9MechanismProfileFactSchema,
    contractionLiquidity: V9MechanismProfileFactSchema,
    indexOracle: V9MechanismProfileFactSchema,
    reflexiveBackstop: V9MechanismProfileFactSchema,
    emergencyRecovery: V9MechanismProfileFactSchema,
    lossRecovery: V9MechanismProfileFactSchema,
    protocolRedemption: V9MechanismProfileFactSchema,
  })
  .strict();

export const V9MechanismProfileReviewSchema = z.discriminatedUnion("profile", [
  z.object({ profile: z.literal("allocated-commodity-claim"), facts: AllocatedCommodityFactsSchema }).strict(),
  z
    .object({
      profile: z.literal("inflation-index-hybrid"),
      exogenousBackingShare: z.number().finite().min(0).max(1),
      reflexiveBackingShare: z.number().finite().min(0).max(1),
      contractionCapacityRatio: z.number().finite().nonnegative(),
      facts: InflationIndexFactsSchema,
    })
    .strict()
    .superRefine((review, ctx) => {
      if (review.exogenousBackingShare + review.reflexiveBackingShare > 1.000001) {
        ctx.addIssue({
          code: "custom",
          path: ["reflexiveBackingShare"],
          message: "Inflation-index backing shares cannot exceed 1",
        });
      }
    }),
]);

export type V9MechanismProfileFact = z.infer<typeof V9MechanismProfileFactSchema>;
export type V9MechanismProfileReview = z.infer<typeof V9MechanismProfileReviewSchema>;
export type V9MechanismScoringProfile = V9MechanismProfileReview["profile"];

export function safetyScoreV9MechanismProfileArchetype(
  profile: V9MechanismScoringProfile,
): "fiat-cash" | "algorithmic" {
  return profile === "allocated-commodity-claim" ? "fiat-cash" : "algorithmic";
}
