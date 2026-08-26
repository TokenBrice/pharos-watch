import { z } from "zod";

const V9ScoreBearingGatesPolicySchema = z
  .object({
    methodologyVersion: z.string().regex(/^\d+\.\d+$/),
    withhold: z
      .object({
        maxScoreExclusive: z.number().finite().min(0).max(100),
        minimumLimitedPillarCount: z.number().int().min(1).max(3),
        requiresLimitedBacking: z.boolean(),
      })
      .strict(),
    danger: z
      .object({
        withholdPegMultiplierFloor: z.number().finite().min(0).max(1),
        fGatePegMultiplierFloor: z.number().finite().min(0).max(1),
        preExitPegMultiplierFloor: z.number().finite().min(0).max(1),
        adverseAttributionPegMultiplierFloor: z.number().finite().min(0).max(1),
        activeDepegMinimumBpsExclusive: z.number().finite().nonnegative(),
        withholdCentralizedMintSeverities: z.array(z.enum(["low", "moderate", "high", "critical"])).min(1),
        fGateCentralizedMintSeverities: z.array(z.enum(["low", "moderate", "high", "critical"])).min(1),
        preExitCentralizedMintSeverities: z.array(z.enum(["low", "moderate", "high", "critical"])).min(1),
        dangerOnlyGrades: z.array(z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"])).min(1),
      })
      .strict()
      .superRefine((danger, ctx) => {
        if (danger.fGatePegMultiplierFloor > danger.withholdPegMultiplierFloor) {
          ctx.addIssue({
            code: "custom",
            path: ["fGatePegMultiplierFloor"],
            message: "F-gate peg floor cannot exceed the withhold danger floor",
          });
        }
      }),
    control: z
      .object({
        materialBridgeHighShareThreshold: z.number().finite().min(0).max(1),
      })
      .strict(),
    evidenceExpiry: z
      .object({
        reviewedResearchMaxAgeSec: z.number().int().positive(),
        accessReviewMaxAgeSec: z.number().int().positive(),
        researchOverlayMaxAgeSec: z.number().int().positive(),
        mechanismOverlayMaxAgeSec: z.number().int().positive(),
        issuerAttestedReserveMaxAgeSec: z.number().int().positive(),
        reviewedReserveClassificationMaxAgeSec: z.number().int().positive(),
        reviewedReserveCompositionMaxAgeSec: z.number().int().positive(),
        reviewedReserveCompositionGraceSec: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type V9ScoreBearingGatesPolicy = z.infer<typeof V9ScoreBearingGatesPolicySchema>;

/**
 * Safety Score V9 digest-bound gates formerly held as code literals.
 *
 * Every gate below except `methodologyVersion` binds the policy semantic
 * digest. `methodologyVersion` is deliberately digest-neutral (see "keeps a
 * gate policy version relabel digest-neutral"), while adding, removing,
 * renaming, or changing a score-bearing gate rotates the digest.
 */
export const V9_SCORE_BEARING_GATES_POLICY_V923 = V9ScoreBearingGatesPolicySchema.parse({
  methodologyVersion: "9.45",
  withhold: {
    maxScoreExclusive: 55,
    minimumLimitedPillarCount: 2,
    requiresLimitedBacking: true,
  },
  danger: {
    withholdPegMultiplierFloor: 0.9,
    fGatePegMultiplierFloor: 0.8,
    preExitPegMultiplierFloor: 0.9,
    adverseAttributionPegMultiplierFloor: 0.9,
    activeDepegMinimumBpsExclusive: 0,
    withholdCentralizedMintSeverities: ["high", "critical"],
    fGateCentralizedMintSeverities: ["critical"],
    preExitCentralizedMintSeverities: ["critical"],
    dangerOnlyGrades: ["F"],
  },
  control: {
    materialBridgeHighShareThreshold: 0.25,
  },
  evidenceExpiry: {
    reviewedResearchMaxAgeSec: 31_536_000,
    accessReviewMaxAgeSec: 31_536_000,
    researchOverlayMaxAgeSec: 31_536_000,
    mechanismOverlayMaxAgeSec: 31_536_000,
    issuerAttestedReserveMaxAgeSec: 31_536_000,
    reviewedReserveClassificationMaxAgeSec: 31_536_000,
    reviewedReserveCompositionMaxAgeSec: 31 * 86_400,
    reviewedReserveCompositionGraceSec: 7 * 86_400,
  },
});

export function parseV9ScoreBearingGatesPolicy(rawPolicy: unknown): V9ScoreBearingGatesPolicy {
  return V9ScoreBearingGatesPolicySchema.parse(rawPolicy);
}
