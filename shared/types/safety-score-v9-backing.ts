import { z } from "zod";
import { V9FactStatusV2Schema, V9FailureDomainRefSchema } from "./safety-score-v9-fact-primitives";

const V9_MECHANISM_QUALITY_LEVELS = ["strong", "adequate", "limited", "weak", "failed"] as const;
const V9MechanismQualityLevelSchema = z.enum(V9_MECHANISM_QUALITY_LEVELS);
export type V9MechanismQualityLevel = z.infer<typeof V9MechanismQualityLevelSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CanonicalFailureDomainsSchema = z
  .array(V9FailureDomainRefSchema)
  .superRefine((domains, ctx) => {
    const keys = domains.map((domain) => `${domain.kind}:${domain.key}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Failure domains must be unique" });
  })
  .transform((domains) =>
    [...domains].sort((left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`)),
  );

const V9MechanismFactV1Schema = z
  .object({
    status: V9FactStatusV2Schema,
    quality: V9MechanismQualityLevelSchema.nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.status.applicability.state === "not-applicable" && fact.quality !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["quality"],
        message: "Not-applicable mechanism facts cannot claim quality",
      });
    }
    if (
      fact.status.observationState === "known" &&
      fact.status.applicability.state === "required" &&
      fact.quality === null
    ) {
      ctx.addIssue({ code: "custom", path: ["quality"], message: "Known required mechanism facts need quality" });
    }
    if (
      (fact.status.observationState === "missing" || fact.status.observationState === "unsupported") &&
      fact.quality !== null
    ) {
      ctx.addIssue({ code: "custom", path: ["quality"], message: "Missing or unsupported facts cannot claim quality" });
    }
  });
export type V9MechanismFactV1 = z.infer<typeof V9MechanismFactV1Schema>;

const V9FiatCashMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("fiat-cash"),
    claimAndSegregation: V9MechanismFactV1Schema,
    custodyContinuity: V9MechanismFactV1Schema,
    assuranceAndReconciliation: V9MechanismFactV1Schema,
  })
  .strict();
export type V9FiatCashMechanismRiskReview = z.infer<typeof V9FiatCashMechanismRiskReviewSchema>;

const V9TbillMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("tbill"),
    fundClaimAndSeniority: V9MechanismFactV1Schema,
    navValuation: V9MechanismFactV1Schema,
    durationAndLiquidity: V9MechanismFactV1Schema,
    lossRecoveryDesign: V9MechanismFactV1Schema,
  })
  .strict();
export type V9TbillMechanismRiskReview = z.infer<typeof V9TbillMechanismRiskReviewSchema>;

const V9CdpMetricApplicabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("measured") }).strict(),
  z
    .object({
      state: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      evidenceRefIds: z.array(z.string().trim().min(1)).min(1),
    })
    .strict(),
]);
export type V9CdpMetricApplicability = z.infer<typeof V9CdpMetricApplicabilitySchema>;

const V9CdpStressBranchContributionSchema = z
  .object({
    branchIndex: z.number().int().nonnegative(),
    stressLiquidatableDebt: z.string().regex(/^[0-9]+$/),
    stressPoolOffsetDebt: z.string().regex(/^[0-9]+$/),
    stressLiquidationCoverageRatio: z.number().finite().min(0).max(1),
  })
  .strict();

const V9CdpStressCodeHashPinSchema = z
  .object({
    name: z.string().trim().min(1),
    address: z.string().regex(/^0x[0-9a-f]{40}$/),
    role: z.string().trim().min(1),
    codeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();

const V9CdpStressMeasurementSourceSchema = z
  .object({
    journalPath: z.string().trim().min(1),
    journalSha256: z.string().regex(/^[0-9a-f]{64}$/),
    block: z
      .object({
        number: z.number().int().nonnegative(),
        hash: z.string().regex(/^0x[0-9a-f]{64}$/),
        timestampUnix: z.number().int().nonnegative(),
        timestampIso: z.string().datetime(),
      })
      .strict(),
    sourcePin: z
      .object({
        repository: z.string().url(),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        liquidationContractPath: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const V9CdpStressReplayVerificationSchema = z
  .object({
    attestationPath: z.string().trim().min(1),
    attestedAt: z.string().date(),
    toolPath: z.string().trim().min(1),
    toolVersion: z.string().trim().min(1),
    mode: z.literal("offline-byte-identical"),
    callsConsumed: z.number().int().nonnegative(),
    codePinsConsumed: z.number().int().nonnegative(),
  })
  .strict();

/** Exact journal projection used to select stress coverage or visible legacy-LCR fallback. */
export const V9CdpStressCoverageFactSchema = z
  .object({
    family: z.string().trim().min(1),
    applicability: z.enum(["measured", "not-measured"]),
    failureReason: z.string().trim().min(1).nullable(),
    complete: z.boolean(),
    blockers: z.array(z.string().trim().min(1)),
    exactReplayPassed: z.boolean(),
    replayVerification: V9CdpStressReplayVerificationSchema.nullable(),
    source: V9CdpStressMeasurementSourceSchema.nullable(),
    shockPolicy: z
      .object({
        scoreShockFractionPpm: z.number().int().min(0).max(1_000_000),
        sensitivityShockFractionsPpm: z.array(z.number().int().min(0).max(1_000_000)),
        debtReconciliationTolerancePpm: z.number().int().nonnegative(),
      })
      .strict(),
    stressShockFraction: z.number().finite().min(0).max(1).nullable(),
    stressLiquidatableDebt: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    stressPoolOffsetDebt: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    stressLiquidationCoverageRatio: z.number().finite().min(0).max(1).nullable(),
    branchContributions: z.array(V9CdpStressBranchContributionSchema),
    codeHashPins: z.array(V9CdpStressCodeHashPinSchema),
    evidenceRefIds: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((fact, ctx) => {
    const measuredValues = [
      fact.stressShockFraction,
      fact.stressLiquidatableDebt,
      fact.stressPoolOffsetDebt,
      fact.stressLiquidationCoverageRatio,
    ];
    if (fact.applicability === "measured" && fact.failureReason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Measured stress facts cannot fail applicability",
      });
    }
    if (fact.applicability === "not-measured" && fact.failureReason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Unavailable stress facts need a failure reason",
      });
    }
    if (fact.complete) {
      if (
        fact.applicability !== "measured" ||
        fact.source === null ||
        measuredValues.some((value) => value === null) ||
        fact.branchContributions.length === 0 ||
        fact.codeHashPins.length === 0 ||
        fact.blockers.length > 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["complete"],
          message: "Complete stress facts require exact measured provenance",
        });
      }
    }
    if (fact.exactReplayPassed !== (fact.replayVerification !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["replayVerification"],
        message: "Exact replay status requires matching verification provenance",
      });
    }
    const branchIndexes = fact.branchContributions.map((branch) => branch.branchIndex);
    if (branchIndexes.some((branchIndex, index) => branchIndex !== index)) {
      ctx.addIssue({
        code: "custom",
        path: ["branchContributions"],
        message: "Stress branches must preserve contiguous journal order",
      });
    }
    const pinNames = fact.codeHashPins.map((pin) => pin.name);
    if (new Set(pinNames).size !== pinNames.length) {
      ctx.addIssue({ code: "custom", path: ["codeHashPins"], message: "Stress code-hash pin names must be unique" });
    }
  });
export type V9CdpStressCoverageFact = z.infer<typeof V9CdpStressCoverageFactSchema>;

const V9CdpMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("cdp"),
    collateralizationRatio: z.number().finite().nonnegative().nullable(),
    liquidationCapacityRatio: z.number().finite().nonnegative().nullable(),
    metricApplicability: z
      .object({
        collateralizationRatio: V9CdpMetricApplicabilitySchema,
        liquidationCapacityRatio: V9CdpMetricApplicabilitySchema,
      })
      .strict(),
    collateralizationParameters: V9MechanismFactV1Schema,
    liquidationMechanics: V9MechanismFactV1Schema,
    backstop: V9MechanismFactV1Schema,
    branchIsolation: V9MechanismFactV1Schema,
    shutdownAndBadDebt: V9MechanismFactV1Schema,
    structuralRedemption: V9MechanismFactV1Schema,
  })
  .strict()
  .superRefine((review, ctx) => {
    for (const metric of ["collateralizationRatio", "liquidationCapacityRatio"] as const) {
      const applicability = review.metricApplicability[metric];
      const value = review[metric];
      if (applicability.state === "measured" && value === null) {
        ctx.addIssue({
          code: "custom",
          path: [metric],
          message: `Measured ${metric} needs a numeric value`,
        });
      }
      if (applicability.state === "not-applicable" && value !== null) {
        ctx.addIssue({
          code: "custom",
          path: [metric],
          message: `Not-applicable ${metric} must be null`,
        });
      }
    }
  });
export type V9CdpMechanismRiskReview = z.infer<typeof V9CdpMechanismRiskReviewSchema>;

const V9SyntheticVenueShareSchema = z
  .object({
    venueKey: z.string().trim().min(1),
    share: z.number().finite().min(0).max(1),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();
export type V9SyntheticVenueShare = z.infer<typeof V9SyntheticVenueShareSchema>;

const V9SyntheticDeltaNeutralMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("synthetic-delta-neutral"),
    hedgeCoverageRatio: z.number().finite().nonnegative(),
    marginBufferPct: z.number().finite().nonnegative(),
    lossAbsorptionShare: z.number().finite().min(0).max(1),
    venueShares: z
      .array(V9SyntheticVenueShareSchema)
      .superRefine((venues, ctx) => {
        const keys = venues.map((venue) => venue.venueKey);
        if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Venue keys must be unique" });
        if (venues.reduce((sum, venue) => sum + venue.share, 0) > 1.000001) {
          ctx.addIssue({ code: "custom", message: "Venue shares cannot exceed 1" });
        }
      })
      .transform((venues) => [...venues].sort((left, right) => compareText(left.venueKey, right.venueKey))),
    venueAndCustody: V9MechanismFactV1Schema,
    hedgeReconciliation: V9MechanismFactV1Schema,
    fundingBasisStress: V9MechanismFactV1Schema,
    marginAndLiquidation: V9MechanismFactV1Schema,
    unwindCapacity: V9MechanismFactV1Schema,
    lossAbsorption: V9MechanismFactV1Schema,
  })
  .strict();
export type V9SyntheticDeltaNeutralMechanismRiskReview = z.infer<
  typeof V9SyntheticDeltaNeutralMechanismRiskReviewSchema
>;

const V9AlgorithmicMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("algorithmic"),
    exogenousBackingShare: z.number().finite().min(0).max(1),
    reflexiveBackingShare: z.number().finite().min(0).max(1),
    contractionCapacityRatio: z.number().finite().nonnegative(),
    contractionCapacity: V9MechanismFactV1Schema,
    confidenceAndIncentives: V9MechanismFactV1Schema,
    oracleAndControlAssumptions: V9MechanismFactV1Schema,
    emergencyRecovery: V9MechanismFactV1Schema,
    lossRecovery: V9MechanismFactV1Schema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.exogenousBackingShare + review.reflexiveBackingShare > 1.000001) {
      ctx.addIssue({ code: "custom", message: "Algorithmic backing shares cannot exceed 1" });
    }
  });
export type V9AlgorithmicMechanismRiskReview = z.infer<typeof V9AlgorithmicMechanismRiskReviewSchema>;

const V9RwaCreditFundMechanismRiskReviewSchema = z
  .object({
    archetype: z.literal("rwa-credit-fund"),
    weightedAverageMaturityDays: z.number().finite().nonnegative(),
    valuationCadenceDays: z.number().finite().nonnegative(),
    creditQuality: V9MechanismFactV1Schema,
    seniority: V9MechanismFactV1Schema,
    legalEnforceability: V9MechanismFactV1Schema,
    valuationCadence: V9MechanismFactV1Schema,
    maturityAndLiquidity: V9MechanismFactV1Schema,
    custody: V9MechanismFactV1Schema,
    recovery: V9MechanismFactV1Schema,
  })
  .strict();
export type V9RwaCreditFundMechanismRiskReview = z.infer<typeof V9RwaCreditFundMechanismRiskReviewSchema>;

export const V9MechanismRiskReviewSchema = z.discriminatedUnion("archetype", [
  V9FiatCashMechanismRiskReviewSchema,
  V9TbillMechanismRiskReviewSchema,
  V9CdpMechanismRiskReviewSchema,
  V9SyntheticDeltaNeutralMechanismRiskReviewSchema,
  V9AlgorithmicMechanismRiskReviewSchema,
  V9RwaCreditFundMechanismRiskReviewSchema,
]);
export type V9MechanismRiskReview = z.infer<typeof V9MechanismRiskReviewSchema>;
