import { z } from "zod";

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTextArray(minLength = 0) {
  return z
    .array(CanonicalTextSchema)
    .min(minLength)
    .superRefine((values, ctx) => {
      const duplicate = values.find((value, index) => values.indexOf(value) !== index);
      if (duplicate !== undefined) {
        ctx.addIssue({ code: "custom", message: `Duplicate canonical value: ${duplicate}` });
      }
    })
    .transform((values) => [...values].sort(compareText));
}

export const V9WrapperFormSchema = z.enum(["pure", "native-staked", "strategy-vault"]);
export type V9WrapperForm = z.infer<typeof V9WrapperFormSchema>;

export const V9WrapperFactDispositionSchema = z.enum([
  "reviewed",
  "not-applicable",
  "issuer-undisclosed",
  "integration-missing",
  "producer-failed",
  "method-unsupported",
]);
export type V9WrapperFactDisposition = z.infer<typeof V9WrapperFactDispositionSchema>;

export const V9WrapperRiskAssessmentSchema = z.enum(["none", "low", "moderate", "high", "critical"]);
export type V9WrapperRiskAssessment = z.infer<typeof V9WrapperRiskAssessmentSchema>;

export const V9_WRAPPER_LOCAL_FACT_KEYS = [
  "contractMutability",
  "custodyEscrow",
  "strategyComplexity",
  "leverage",
  "rehypothecationCorrelation",
  "shareAccountingNavOracle",
  "withdrawalTerms",
  "measuredUnwind",
  "lossAbsorptionEmergencyControls",
] as const;
export const V9WrapperLocalFactKeySchema = z.enum(V9_WRAPPER_LOCAL_FACT_KEYS);
export type V9WrapperLocalFactKey = z.infer<typeof V9WrapperLocalFactKeySchema>;

export const V9WrapperLocalDimensionFactSchema = z
  .object({
    disposition: V9WrapperFactDispositionSchema,
    assessment: V9WrapperRiskAssessmentSchema.nullable(),
    signals: canonicalTextArray(1),
    evidenceRefIds: canonicalTextArray(),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.disposition === "reviewed") {
      if (fact.assessment === null) {
        ctx.addIssue({ code: "custom", path: ["assessment"], message: "Reviewed wrapper facts require an assessment" });
      }
      if (fact.evidenceRefIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "Reviewed wrapper facts require evidence" });
      }
      return;
    }
    if (fact.assessment !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["assessment"],
        message: "Unavailable or not-applicable wrapper facts cannot claim a risk assessment",
      });
    }
  });
export type V9WrapperLocalDimensionFact = z.infer<typeof V9WrapperLocalDimensionFactSchema>;

const V9WrapperLocalDimensionsSchema = z
  .object({
    contractMutability: V9WrapperLocalDimensionFactSchema,
    custodyEscrow: V9WrapperLocalDimensionFactSchema,
    strategyComplexity: V9WrapperLocalDimensionFactSchema,
    leverage: V9WrapperLocalDimensionFactSchema,
    rehypothecationCorrelation: V9WrapperLocalDimensionFactSchema,
    shareAccountingNavOracle: V9WrapperLocalDimensionFactSchema,
    withdrawalTerms: V9WrapperLocalDimensionFactSchema,
    measuredUnwind: V9WrapperLocalDimensionFactSchema,
    lossAbsorptionEmergencyControls: V9WrapperLocalDimensionFactSchema,
  })
  .strict();
export type V9WrapperLocalDimensions = z.infer<typeof V9WrapperLocalDimensionsSchema>;

export const V9WrapperRiskTransferMechanismSchema = z.enum([
  "none",
  "first-loss-capital",
  "insurance",
  "overcollateralization",
  "other",
  "unknown",
]);
export type V9WrapperRiskTransferMechanism = z.infer<typeof V9WrapperRiskTransferMechanismSchema>;

export const V9WrapperRiskTransferFactSchema = z
  .object({
    disposition: V9WrapperFactDispositionSchema,
    mechanism: V9WrapperRiskTransferMechanismSchema,
    maximumParentLossAbsorptionPoints: z.number().finite().min(0).max(100),
    signals: canonicalTextArray(1),
    evidenceRefIds: canonicalTextArray(),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.disposition === "reviewed") {
      if (fact.mechanism === "unknown") {
        ctx.addIssue({ code: "custom", path: ["mechanism"], message: "Reviewed risk transfer cannot be unknown" });
      }
      if (fact.evidenceRefIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "Reviewed risk transfer requires evidence" });
      }
      if (
        (fact.mechanism === "none") !==
        (fact.maximumParentLossAbsorptionPoints === 0)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["maximumParentLossAbsorptionPoints"],
          message: "Reviewed risk-transfer credit requires an explicit loss-absorption mechanism",
        });
      }
      return;
    }
    if (
      fact.mechanism !== (fact.disposition === "not-applicable" ? "none" : "unknown") ||
      fact.maximumParentLossAbsorptionPoints !== 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unavailable risk transfer must be unknown and zero; not-applicable risk transfer must be none and zero",
      });
    }
  });
export type V9WrapperRiskTransferFact = z.infer<typeof V9WrapperRiskTransferFactSchema>;

const V9NotWrapperLocalFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicability: z.literal("not-wrapper"),
    evidenceRefIds: canonicalTextArray(),
  })
  .strict();

const V9ApplicableWrapperLocalFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicability: z.literal("wrapper"),
    form: V9WrapperFormSchema,
    formDisposition: V9WrapperFactDispositionSchema,
    formSignals: canonicalTextArray(1),
    formEvidenceRefIds: canonicalTextArray(),
    facts: V9WrapperLocalDimensionsSchema,
    riskTransfer: V9WrapperRiskTransferFactSchema,
  })
  .strict()
  .superRefine((facts, ctx) => {
    if (facts.formDisposition === "reviewed" && facts.formEvidenceRefIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["formEvidenceRefIds"],
        message: "Reviewed wrapper form requires evidence",
      });
    }
  });

export const V9WrapperLocalFactsSchema = z.discriminatedUnion("applicability", [
  V9NotWrapperLocalFactsSchema,
  V9ApplicableWrapperLocalFactsSchema,
]);
export type V9WrapperLocalFacts = z.infer<typeof V9WrapperLocalFactsSchema>;
export type V9ApplicableWrapperLocalFacts = z.infer<typeof V9ApplicableWrapperLocalFactsSchema>;
