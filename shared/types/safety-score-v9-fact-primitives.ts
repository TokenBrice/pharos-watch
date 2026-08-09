import { z } from "zod";

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalArrayBy<T>(schema: z.ZodType<T>, keyOf: (value: T) => string) {
  return z
    .array(schema)
    .superRefine((values, ctx) => {
      const keys = values.map(keyOf);
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate !== undefined) ctx.addIssue({ code: "custom", message: `Duplicate canonical key: ${duplicate}` });
    })
    .transform((values) => [...values].sort((left, right) => compareText(keyOf(left), keyOf(right))));
}

const CanonicalStringArraySchema = canonicalArrayBy(CanonicalTextSchema, (value) => value);

const V9FactApplicabilitySchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("required"),
      policyRuleId: CanonicalTextSchema,
      rationale: z.null(),
      gapId: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("not-applicable"),
      policyRuleId: CanonicalTextSchema,
      rationale: CanonicalTextSchema,
      gapId: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unresolved"),
      policyRuleId: CanonicalTextSchema,
      rationale: CanonicalTextSchema,
      gapId: CanonicalTextSchema,
    })
    .strict(),
]);
export type V9FactApplicability = z.infer<typeof V9FactApplicabilitySchema>;

export const V9ObservationStateSchema = z.enum(["known", "missing", "stale", "unsupported", "bounded-unknown"]);
export type V9ObservationState = z.infer<typeof V9ObservationStateSchema>;

export const V9EvidenceResponsibilitySchema = z.enum([
  "measured-adverse",
  "issuer-undisclosed",
  "integration-missing",
  "producer-failed",
  "method-unsupported",
]);
export type V9EvidenceResponsibility = z.infer<typeof V9EvidenceResponsibilitySchema>;

export const V9FactStatusV2Schema = z
  .object({
    applicability: V9FactApplicabilitySchema,
    observationState: V9ObservationStateSchema,
    evidenceRefIds: CanonicalStringArraySchema,
    gapIds: CanonicalStringArraySchema,
  })
  .strict()
  .superRefine((status, ctx) => {
    if (status.applicability.state === "not-applicable") {
      if (status.observationState !== "known" || status.gapIds.length > 0) {
        ctx.addIssue({ code: "custom", message: "Reviewed not-applicable facts must be known and cannot carry gaps" });
      }
    }
    if (status.applicability.state === "unresolved" && !status.gapIds.includes(status.applicability.gapId)) {
      ctx.addIssue({ code: "custom", path: ["gapIds"], message: "Unresolved applicability must reference its gap" });
    }
    if (status.observationState === "known" && status.gapIds.length > 0) {
      ctx.addIssue({ code: "custom", path: ["gapIds"], message: "Known facts cannot carry observation gaps" });
    }
    if (status.observationState !== "known" && status.gapIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["gapIds"], message: "Non-known facts require at least one gap" });
    }
    if (
      (status.observationState === "known" ||
        status.observationState === "stale" ||
        status.observationState === "bounded-unknown") &&
      status.evidenceRefIds.length === 0
    ) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "This fact state requires evidence" });
    }
  });
export type V9FactStatusV2 = z.infer<typeof V9FactStatusV2Schema>;

const V9FailureDomainKindSchema = z.enum([
  "reserve-issuer",
  "reserve-custodian",
  "mint-control",
  "upgrade-control",
  "oracle-feed",
  "bridge-route",
  "redemption-rail",
  "output-asset",
  "chain",
  "dex-protocol",
]);
export type V9FailureDomainKind = z.infer<typeof V9FailureDomainKindSchema>;

export const V9FailureDomainRefSchema = z
  .object({ kind: V9FailureDomainKindSchema, key: CanonicalTextSchema })
  .strict();
export type V9FailureDomainRef = z.infer<typeof V9FailureDomainRefSchema>;
