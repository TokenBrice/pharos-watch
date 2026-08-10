import { z } from "zod";
import { V9EvidenceResponsibilitySchema, compareText } from "./safety-score-v9-fact-primitives";
import { V9TypedFactPathSchema, V9ResolvedMechanismArchetypeSchema } from "./safety-score-v9-facts";
import {
  V9ManualInputClassificationSchema,
  V9PolicyTreatmentSchema,
  V9ReasonCodeSchema,
  V9ReasonOwnerDomainSchema,
  V9ReasonReleaseSeveritySchema,
} from "./safety-score-v9";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
const UnixSecondsSchema = z.number().int().nonnegative();
const NonNegativeUsdSchema = z.number().finite().nonnegative();

function addCanonicalStringArrayIssues(values: readonly string[], ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path, message: "Values must be unique" });
  }
  if (values.some((value, index) => index > 0 && compareText(values[index - 1]!, value) >= 0)) {
    ctx.addIssue({ code: "custom", path, message: "Values must be in canonical ascending order" });
  }
}

const CanonicalStringArraySchema = z
  .array(CanonicalTextSchema)
  .superRefine((values, ctx) => addCanonicalStringArrayIssues(values, ctx, []));

export const V9EvidenceGapActionSchema = z.enum([
  "adjudicate-bounded-unknown",
  "collect-evidence",
  "implement-producer-capability",
  "reconcile-policy-binding",
  "refresh-evidence",
  "resolve-applicability",
  "resolve-methodology-decision",
]);
export type V9EvidenceGapAction = z.infer<typeof V9EvidenceGapActionSchema>;

export const V9EvidenceGapPolicyBindingIssueSchema = z.enum([
  "archetype-not-permitted",
  "fact-owner-domain-mismatch",
  "path-kind-not-permitted",
]);
export type V9EvidenceGapPolicyBindingIssue = z.infer<typeof V9EvidenceGapPolicyBindingIssueSchema>;

export const V9EvidenceGapMaterialityBasisSchema = z.enum([
  "asset-wide",
  "collateral-exposure",
  "deployment-supply-share",
  "methodology-decision",
  "optional-exit-route",
  "score-eligible-exit-route",
  "serial-claim",
  "unresolved",
]);
export type V9EvidenceGapMaterialityBasis = z.infer<typeof V9EvidenceGapMaterialityBasisSchema>;

export const V9EvidenceGapMaterialityV1Schema = z
  .object({
    basis: V9EvidenceGapMaterialityBasisSchema,
    fractionOfAsset: z.number().finite().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((materiality, ctx) => {
    const requiresFraction = new Set([
      "asset-wide",
      "collateral-exposure",
      "deployment-supply-share",
      "serial-claim",
    ]);
    if (requiresFraction.has(materiality.basis) && materiality.fractionOfAsset === null) {
      ctx.addIssue({ code: "custom", path: ["fractionOfAsset"], message: "This materiality basis requires a fraction" });
    }
    if (materiality.basis === "serial-claim" && materiality.fractionOfAsset !== 1) {
      ctx.addIssue({ code: "custom", path: ["fractionOfAsset"], message: "A serial claim is asset-wide" });
    }
    if (materiality.basis === "asset-wide" && materiality.fractionOfAsset !== 1) {
      ctx.addIssue({ code: "custom", path: ["fractionOfAsset"], message: "Asset-wide materiality requires 1" });
    }
    if (
      new Set([
        "methodology-decision",
        "optional-exit-route",
        "score-eligible-exit-route",
        "unresolved",
      ]).has(materiality.basis) &&
      materiality.fractionOfAsset !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fractionOfAsset"],
        message: "This materiality basis cannot claim a numeric asset fraction",
      });
    }
  });
export type V9EvidenceGapMaterialityV1 = z.infer<typeof V9EvidenceGapMaterialityV1Schema>;

export const V9EvidenceGapSupplyWeightV1Schema = z
  .object({
    state: z.enum(["current-valid", "unavailable"]),
    canonicalUsd: NonNegativeUsdSchema.nullable(),
    materialityWeightedUsd: NonNegativeUsdSchema.nullable(),
    sourceGenerationId: CanonicalTextSchema,
  })
  .strict()
  .superRefine((weight, ctx) => {
    if (weight.state === "current-valid" && weight.canonicalUsd === null) {
      ctx.addIssue({ code: "custom", path: ["canonicalUsd"], message: "Current supply weight requires a value" });
    }
    if (weight.state === "unavailable" && (weight.canonicalUsd !== null || weight.materialityWeightedUsd !== null)) {
      ctx.addIssue({ code: "custom", message: "Unavailable supply weight cannot claim numeric values" });
    }
    if (
      weight.canonicalUsd !== null &&
      weight.materialityWeightedUsd !== null &&
      weight.materialityWeightedUsd > weight.canonicalUsd
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["materialityWeightedUsd"],
        message: "Materiality-weighted supply cannot exceed canonical supply",
      });
    }
  });
export type V9EvidenceGapSupplyWeightV1 = z.infer<typeof V9EvidenceGapSupplyWeightV1Schema>;

const V9EvidenceGapQueueEntryV1Fields = {
  priority: z.number().int().positive(),
  queueKey: Sha256Schema,
  assetId: CanonicalTextSchema,
  archetype: V9ResolvedMechanismArchetypeSchema,
  gapId: CanonicalTextSchema,
  reasonCode: V9ReasonCodeSchema,
  ownerDomain: V9ReasonOwnerDomainSchema,
  factOwnerDomain: V9ReasonOwnerDomainSchema,
  policyBindingIssues: z
    .array(V9EvidenceGapPolicyBindingIssueSchema)
    .superRefine((values, ctx) => addCanonicalStringArrayIssues(values, ctx, [])),
  policyRuleId: CanonicalTextSchema,
  applicability: z.enum(["required", "unresolved"]),
  observationState: z.enum(["missing", "stale", "unsupported", "bounded-unknown"]),
  path: V9TypedFactPathSchema,
  materiality: V9EvidenceGapMaterialityV1Schema,
  supplyWeight: V9EvidenceGapSupplyWeightV1Schema,
  action: V9EvidenceGapActionSchema,
  releaseSeverity: V9ReasonReleaseSeveritySchema,
  auditClassification: V9ManualInputClassificationSchema,
  treatment: V9PolicyTreatmentSchema,
  critical: z.boolean(),
  publicLabel: CanonicalTextSchema,
  message: CanonicalTextSchema,
  evidenceRefIds: CanonicalStringArraySchema,
} as const;

type V9EvidenceGapQueueEntryBase = z.infer<z.ZodObject<typeof V9EvidenceGapQueueEntryV1Fields>>;

function addEntryConsistencyIssues(entry: V9EvidenceGapQueueEntryBase, ctx: z.RefinementCtx): void {
  const ownerMismatch = entry.ownerDomain !== entry.factOwnerDomain;
  if (ownerMismatch !== entry.policyBindingIssues.includes("fact-owner-domain-mismatch")) {
    ctx.addIssue({ code: "custom", path: ["policyBindingIssues"], message: "Owner binding disposition is inconsistent" });
  }
  if ((entry.policyBindingIssues.length > 0) !== (entry.action === "reconcile-policy-binding")) {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Policy binding drift requires reconciliation" });
  }
  if (entry.critical !== (entry.treatment === "NR")) {
    ctx.addIssue({ code: "custom", path: ["critical"], message: "Criticality must match NR treatment" });
  }
  if (entry.supplyWeight.state !== "current-valid") return;
  const fraction = entry.materiality.fractionOfAsset;
  const weightedUsd = entry.supplyWeight.materialityWeightedUsd;
  if ((fraction === null) !== (weightedUsd === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["supplyWeight", "materialityWeightedUsd"],
      message: "Weighted supply requires an established materiality fraction",
    });
  } else if (
    fraction !== null &&
    weightedUsd !== null &&
    entry.supplyWeight.canonicalUsd !== null &&
    Math.abs(weightedUsd - entry.supplyWeight.canonicalUsd * fraction) > 0.000001
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supplyWeight", "materialityWeightedUsd"],
      message: "Weighted supply is inconsistent with materiality",
    });
  }
}

export const V9EvidenceGapQueueEntryV1Schema = z
  .object(V9EvidenceGapQueueEntryV1Fields)
  .strict()
  .superRefine(addEntryConsistencyIssues);
export type V9EvidenceGapQueueEntryV1 = z.infer<typeof V9EvidenceGapQueueEntryV1Schema>;

export const V9EvidenceGapQueueEntryV2Schema = z
  .object({
    ...V9EvidenceGapQueueEntryV1Fields,
    responsibility: V9EvidenceResponsibilitySchema,
  })
  .strict()
  .superRefine(addEntryConsistencyIssues);
export type V9EvidenceGapQueueEntryV2 = z.infer<typeof V9EvidenceGapQueueEntryV2Schema>;

const V9EvidenceGapDomainCountSchema = z
  .object({ domain: V9ReasonOwnerDomainSchema, count: z.number().int().nonnegative() })
  .strict();
const V9EvidenceGapActionCountSchema = z
  .object({ action: V9EvidenceGapActionSchema, count: z.number().int().nonnegative() })
  .strict();

const V9EvidenceGapQueueSummaryV1Fields = {
  activeAssetCount: z.number().int().positive(),
  affectedAssetCount: z.number().int().nonnegative(),
  gapCount: z.number().int().nonnegative(),
  criticalGapCount: z.number().int().nonnegative(),
  releaseBlockerGapCount: z.number().int().nonnegative(),
  reviewRequiredGapCount: z.number().int().nonnegative(),
  diagnosticGapCount: z.number().int().nonnegative(),
  policyBindingMismatchGapCount: z.number().int().nonnegative(),
  knownSupplyWeightGapCount: z.number().int().nonnegative(),
  unavailableSupplyWeightGapCount: z.number().int().nonnegative(),
  domainCounts: z.array(V9EvidenceGapDomainCountSchema),
  actionCounts: z.array(V9EvidenceGapActionCountSchema),
} as const;

const V9EvidenceGapQueueCoreV1Fields = {
  schemaVersion: z.literal(1),
  purpose: z.literal("evidence-work-queue-not-release-gate"),
  status: z.enum(["clear", "work-required"]),
  facts: z
    .object({
      factSetDigest: Sha256Schema,
      baseInputGenerationId: BaseInputGenerationIdSchema,
      asOfSec: UnixSecondsSchema,
      compiledAtSec: UnixSecondsSchema,
    })
    .strict(),
  policy: z.object({ policyId: CanonicalTextSchema, semanticDigest: Sha256Schema }).strict(),
  summary: z.object(V9EvidenceGapQueueSummaryV1Fields).strict(),
  entries: z.array(V9EvidenceGapQueueEntryV1Schema),
} as const;

type V9EvidenceGapQueueConsistencyValue = {
  status: "clear" | "work-required";
  summary: z.infer<z.ZodObject<typeof V9EvidenceGapQueueSummaryV1Fields>>;
  entries: readonly V9EvidenceGapQueueEntryBase[];
};

function addQueueConsistencyIssues(
  queue: V9EvidenceGapQueueConsistencyValue,
  ctx: z.RefinementCtx,
): void {
  const entries = queue.entries;
  const queueKeys = entries.map((entry) => entry.queueKey);
  if (new Set(queueKeys).size !== queueKeys.length) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "Queue keys must be unique" });
  }
  if (entries.some((entry, index) => entry.priority !== index + 1)) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "Queue priorities must be contiguous and ordered" });
  }
  if ((queue.status === "clear") !== (entries.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Queue status and entry count disagree" });
  }

  const expected = {
    affectedAssetCount: new Set(entries.map((entry) => entry.assetId)).size,
    gapCount: entries.length,
    criticalGapCount: entries.filter((entry) => entry.critical).length,
    releaseBlockerGapCount: entries.filter((entry) => entry.releaseSeverity === "release-blocker").length,
    reviewRequiredGapCount: entries.filter((entry) => entry.releaseSeverity === "review-required").length,
    diagnosticGapCount: entries.filter((entry) => entry.releaseSeverity === "diagnostic").length,
    policyBindingMismatchGapCount: entries.filter((entry) => entry.policyBindingIssues.length > 0).length,
    knownSupplyWeightGapCount: entries.filter((entry) => entry.supplyWeight.state === "current-valid").length,
    unavailableSupplyWeightGapCount: entries.filter((entry) => entry.supplyWeight.state === "unavailable").length,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (queue.summary[field as keyof typeof expected] !== value) {
      ctx.addIssue({ code: "custom", path: ["summary", field], message: `Expected ${value}` });
    }
  }

  const expectedDomainCounts = new Map<string, number>();
  const expectedActionCounts = new Map<string, number>();
  for (const entry of entries) {
    expectedDomainCounts.set(entry.ownerDomain, (expectedDomainCounts.get(entry.ownerDomain) ?? 0) + 1);
    expectedActionCounts.set(entry.action, (expectedActionCounts.get(entry.action) ?? 0) + 1);
  }
  const domainKeys = queue.summary.domainCounts.map((entry) => entry.domain);
  const actionKeys = queue.summary.actionCounts.map((entry) => entry.action);
  addCanonicalStringArrayIssues(domainKeys, ctx, ["summary", "domainCounts"]);
  addCanonicalStringArrayIssues(actionKeys, ctx, ["summary", "actionCounts"]);
  const expectedDomainKeys = [...expectedDomainCounts.keys()].sort(compareText);
  const expectedActionKeys = [...expectedActionCounts.keys()].sort(compareText);
  if (JSON.stringify(domainKeys) !== JSON.stringify(expectedDomainKeys)) {
    ctx.addIssue({ code: "custom", path: ["summary", "domainCounts"], message: "Domain count keys are incomplete" });
  }
  if (JSON.stringify(actionKeys) !== JSON.stringify(expectedActionKeys)) {
    ctx.addIssue({ code: "custom", path: ["summary", "actionCounts"], message: "Action count keys are incomplete" });
  }
  for (const entry of queue.summary.domainCounts) {
    if (entry.count !== (expectedDomainCounts.get(entry.domain) ?? 0)) {
      ctx.addIssue({ code: "custom", path: ["summary", "domainCounts"], message: `Count mismatch for ${entry.domain}` });
    }
  }
  for (const entry of queue.summary.actionCounts) {
    if (entry.count !== (expectedActionCounts.get(entry.action) ?? 0)) {
      ctx.addIssue({ code: "custom", path: ["summary", "actionCounts"], message: `Count mismatch for ${entry.action}` });
    }
  }
}

const V9EvidenceGapQueueCoreObjectV1Schema = z.object(V9EvidenceGapQueueCoreV1Fields).strict();
export const V9EvidenceGapQueueCoreV1Schema = V9EvidenceGapQueueCoreObjectV1Schema.superRefine(
  addQueueConsistencyIssues,
);
export type V9EvidenceGapQueueCoreV1 = z.infer<typeof V9EvidenceGapQueueCoreV1Schema>;

export const V9EvidenceGapQueueV1Schema = z
  .object({ ...V9EvidenceGapQueueCoreV1Fields, queueDigest: Sha256Schema })
  .strict()
  .superRefine(addQueueConsistencyIssues);
export type V9EvidenceGapQueueV1 = z.infer<typeof V9EvidenceGapQueueV1Schema>;

const V9EvidenceResponsibilityCountSchema = z
  .object({
    responsibility: V9EvidenceResponsibilitySchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const V9EvidenceGapQueueFactsV2Schema = z
  .object({
    sourceSchemaVersion: z.literal(3),
    sourceFactSetDigest: Sha256Schema,
    evaluationFactSetDigest: Sha256Schema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    asOfSec: UnixSecondsSchema,
    compiledAtSec: UnixSecondsSchema,
  })
  .strict()
  .superRefine((facts, ctx) => {
    const digestsMatch = facts.sourceFactSetDigest === facts.evaluationFactSetDigest;
    if (!digestsMatch) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluationFactSetDigest"],
        message: "Native V3 source and evaluation fact-set digests must match",
      });
    }
  });

const V9EvidenceGapQueueCoreV2Fields = {
  schemaVersion: z.literal(2),
  purpose: z.literal("evidence-work-queue-not-release-gate"),
  status: z.enum(["clear", "work-required"]),
  facts: V9EvidenceGapQueueFactsV2Schema,
  policy: z.object({ policyId: CanonicalTextSchema, semanticDigest: Sha256Schema }).strict(),
  summary: z
    .object({
      ...V9EvidenceGapQueueSummaryV1Fields,
      responsibilityCounts: z.array(V9EvidenceResponsibilityCountSchema),
    })
    .strict(),
  entries: z.array(V9EvidenceGapQueueEntryV2Schema),
} as const;

function addQueueV2ConsistencyIssues(
  queue: z.infer<z.ZodObject<typeof V9EvidenceGapQueueCoreV2Fields>>,
  ctx: z.RefinementCtx,
): void {
  addQueueConsistencyIssues(queue, ctx);
  const expectedResponsibilities = [...V9EvidenceResponsibilitySchema.options].sort(compareText);
  const actualResponsibilities = queue.summary.responsibilityCounts.map((entry) => entry.responsibility);
  addCanonicalStringArrayIssues(actualResponsibilities, ctx, ["summary", "responsibilityCounts"]);
  if (JSON.stringify(actualResponsibilities) !== JSON.stringify(expectedResponsibilities)) {
    ctx.addIssue({
      code: "custom",
      path: ["summary", "responsibilityCounts"],
      message: "Responsibility counts must distinguish every registered responsibility",
    });
  }
  const counts = new Map(expectedResponsibilities.map((responsibility) => [responsibility, 0]));
  for (const entry of queue.entries) {
    counts.set(entry.responsibility, (counts.get(entry.responsibility) ?? 0) + 1);
  }
  for (const entry of queue.summary.responsibilityCounts) {
    if (entry.count !== counts.get(entry.responsibility)) {
      ctx.addIssue({
        code: "custom",
        path: ["summary", "responsibilityCounts"],
        message: `Count mismatch for ${entry.responsibility}`,
      });
    }
  }
}

const V9EvidenceGapQueueCoreObjectV2Schema = z.object(V9EvidenceGapQueueCoreV2Fields).strict();
export const V9EvidenceGapQueueCoreV2Schema =
  V9EvidenceGapQueueCoreObjectV2Schema.superRefine(addQueueV2ConsistencyIssues);
export type V9EvidenceGapQueueCoreV2 = z.infer<typeof V9EvidenceGapQueueCoreV2Schema>;

export const V9EvidenceGapQueueV2Schema = z
  .object({ ...V9EvidenceGapQueueCoreV2Fields, queueDigest: Sha256Schema })
  .strict()
  .superRefine(addQueueV2ConsistencyIssues);
export type V9EvidenceGapQueueV2 = z.infer<typeof V9EvidenceGapQueueV2Schema>;

export const V9EvidenceGapQueueSchema = z.union([V9EvidenceGapQueueV1Schema, V9EvidenceGapQueueV2Schema]);
export type V9EvidenceGapQueue = z.infer<typeof V9EvidenceGapQueueSchema>;
