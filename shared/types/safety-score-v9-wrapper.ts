import { z } from "zod";
import {
  canonicalTextArray,
  V9FactStatusV2Schema,
} from "./safety-score-v9-fact-primitives";
import { issue } from "./safety-schema-primitives";

export const V9WrapperFormSchema = z.enum(["pure", "native-staked", "strategy-vault"]);
export type V9WrapperForm = z.infer<typeof V9WrapperFormSchema>;

export const V9WrapperFactDispositionSchema = z.enum([
  "reviewed",
  "not-applicable",
  "issuer-undisclosed",
  "integration-missing",
  "producer-failed",
  "method-unsupported",
  "unresearched", "public-data-uncurated",
]);


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


const V9NotWrapperLocalFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicability: z.literal("not-wrapper"),
    evidenceRefIds: canonicalTextArray(0, "value"),
  })
  .strict();

const V9ApplicableWrapperLocalFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicability: z.literal("wrapper"),
    form: V9WrapperFormSchema,
    formDisposition: V9WrapperFactDispositionSchema,
    formSignals: canonicalTextArray(1, "value"),
    formEvidenceRefIds: canonicalTextArray(0, "value"),
    formStatus: V9FactStatusV2Schema.optional(),
    // A reviewed withholding is an override, not positive evidence of a parent
    // claim. Absence retains the evaluator's existing measured-exposure gates.
    parentBackingInheritance: z.object({
      state: z.literal("withheld"),
      reason: z.literal("mixed-strategy-without-measured-parent-claim"),
      evidenceRefIds: canonicalTextArray(1, "value"),
    }).strict().optional(),
  })
  .strict()
  .superRefine((facts, ctx) => {
    if (facts.formDisposition === "reviewed" && facts.formEvidenceRefIds.length === 0) {
      issue(ctx, ["formEvidenceRefIds"], "Reviewed wrapper form requires evidence");
    }
  });

export const V9WrapperLocalFactsSchema = z.discriminatedUnion("applicability", [
  V9NotWrapperLocalFactsSchema,
  V9ApplicableWrapperLocalFactsSchema,
]);
export type V9WrapperLocalFacts = z.infer<typeof V9WrapperLocalFactsSchema>;
export type V9ApplicableWrapperLocalFacts = z.infer<typeof V9ApplicableWrapperLocalFactsSchema>;
