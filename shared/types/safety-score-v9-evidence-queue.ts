import { z } from "zod";
import { V9EvidenceResponsibilitySchema, compareText } from "./safety-score-v9-fact-primitives";
import {
  V9BridgeJoinDiagnosticsV1Schema,
  V9TypedFactPathSchema,
  V9ResolvedMechanismArchetypeSchema,
} from "./safety-score-v9-facts";
import {
  V9DocumentationReasonSchema,
  V9DocumentationThresholdKindSchema,
  V9ManualInputClassificationSchema,
  V9PolicyTreatmentSchema,
  V9ReasonCodeSchema,
  V9ReasonOwnerDomainSchema,
  V9ReasonReleaseSeveritySchema,
} from "./safety-score-v9";
import { parseIsoDateOrUtcInstantSec } from "./date-primitives";
import { issue,
  BaseInputGenerationIdSchema,
  CanonicalTextSchema,
  Sha256Schema,
  UnixSecondsSchema,
} from "./safety-schema-primitives";
import { V9EvidenceCauseProofSchema, V9EvidenceCauseSchema, V9EvidenceCauseScopeSchema, v9EvidenceResponsibilityForCauseProof } from "./safety-score-v9-causes";

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

const V9EvidenceGapActionSchema = z.enum([
  "adjudicate-bounded-unknown",
  "collect-evidence",
  "implement-producer-capability",
  "reconcile-policy-binding",
  "refresh-evidence",
  "resolve-applicability",
  "resolve-methodology-decision",
]);
export type V9EvidenceGapAction = z.infer<typeof V9EvidenceGapActionSchema>;

const V9EvidenceGapPolicyBindingIssueSchema = z.enum([
  "archetype-not-permitted",
  "fact-owner-domain-mismatch",
  "path-kind-not-permitted",
]);
export type V9EvidenceGapPolicyBindingIssue = z.infer<typeof V9EvidenceGapPolicyBindingIssueSchema>;

const V9EvidenceGapMaterialityBasisSchema = z.enum([
  "asset-wide",
  "collateral-exposure",
  "deployment-supply-share",
  "methodology-decision",
  "optional-exit-route",
  "score-eligible-exit-route",
  "serial-claim",
  "unresolved",
]);

const V9EvidenceGapMaterialityV1Schema = z
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
      issue(ctx, ["fractionOfAsset"], "This materiality basis cannot claim a numeric asset fraction");
    }
  });
export type V9EvidenceGapMaterialityV1 = z.infer<typeof V9EvidenceGapMaterialityV1Schema>;

const V9EvidenceGapSupplyWeightV1Schema = z
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
      issue(ctx, ["materialityWeightedUsd"], "Materiality-weighted supply cannot exceed canonical supply");
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
    issue(ctx, ["supplyWeight", "materialityWeightedUsd"], "Weighted supply requires an established materiality fraction");
  } else if (
    fraction !== null &&
    weightedUsd !== null &&
    entry.supplyWeight.canonicalUsd !== null &&
    Math.abs(weightedUsd - entry.supplyWeight.canonicalUsd * fraction) > 0.000001
  ) {
    issue(ctx, ["supplyWeight", "materialityWeightedUsd"], "Weighted supply is inconsistent with materiality");
  }
}

const V9EvidenceGapQueueEntryV1Schema = z
  .object(V9EvidenceGapQueueEntryV1Fields)
  .strict()
  .superRefine(addEntryConsistencyIssues);

/**
 * ODR-D5a: the bridge-join view the richer missing-data registry already
 * carries verbatim on `economicControlReview.bridge`, joined into the terse
 * queue so a bridge work item names the row it failed on instead of leaving the
 * reader to re-derive the join. Diagnostic only — nothing here scores.
 */
const V9EvidenceGapBridgeJoinFailureV1Schema = z
  .object({
    code: z.enum([
      "supply-partition-unreconciled",
      "duplicate-bridge-route-control",
      "reviewed-native-row-carries-control",
      "reviewed-row-kind-unresolved",
      "reviewed-row-control-join-not-unique",
      "reviewed-row-control-unproven",
      "unresolved-row-control-join-not-unique",
      "unresolved-row-control-unproven",
    ]),
    deploymentRouteKey: CanonicalTextSchema.nullable(),
    reviewState: z.enum(["selected-reviewed", "selected-unresolved", "unmatched"]).nullable(),
    reviewedRouteKind: z.enum(["native", "controlled"]).nullable(),
    supplyShare: z.number().finite().min(0).max(1).nullable(),
    controlKeys: CanonicalStringArraySchema,
  })
  .strict();

const V9EvidenceGapBridgeJoinV1Schema = z
  .object({
    diagnostics: V9BridgeJoinDiagnosticsV1Schema.nullable(),
    subthresholdUnresolvedJoin: z
      .object({ complete: z.boolean(), cause: V9EvidenceGapBridgeJoinFailureV1Schema.nullable() })
      .strict()
      .superRefine((value, ctx) => {
        if (value.complete !== (value.cause === null)) {
          ctx.addIssue({ code: "custom", path: ["cause"], message: "An incomplete join must name its cause" });
        }
      }),
  })
  .strict();
export type V9EvidenceGapBridgeJoinV1 = z.infer<typeof V9EvidenceGapBridgeJoinV1Schema>;

const V9EvidenceGapDocumentationThresholdSchema = z
  .object({
    kind: V9DocumentationThresholdKindSchema,
    /** The policy bar resolved to a share (percent keys are divided by 100). */
    value: z.number().finite().nonnegative(),
    /** 3e admits a reviewed upper bound; the bound is not a measurement. */
    evidenceKind: z.enum(["exact", "upper-bound"]).optional(),
  })
  .strict();

/**
 * The documentation class copied from the shared classifier
 * (`shared/lib/safety-score-v9/documentation.ts`). Counting and routing only:
 * nothing here may be read by scoring, and the gap keeps its identity,
 * treatment, cause and binding.
 */
const V9EvidenceGapDocumentationSchema = z
  .object({
    class: z.literal("documentation"),
    reason: V9DocumentationReasonSchema,
    policyRef: CanonicalTextSchema,
    /** Present exactly on the two barrier reasons; null on the predicate reasons. */
    threshold: V9EvidenceGapDocumentationThresholdSchema.nullable(),
  })
  .strict()
  .superRefine((documentation, ctx) => {
    if (documentation.policyRef !== `semantic.evidence.documentation.reasons.${documentation.reason}`) {
      issue(ctx, ["policyRef"], "A documentation reference names the policy reason it was classified under");
    }
    const kind =
      documentation.reason === "reserve-dust"
        ? "reserve-book-share"
        : documentation.reason === "immaterial-deployment"
          ? "known-share-pct"
          : null;
    if (kind === null ? documentation.threshold !== null : documentation.threshold?.kind !== kind) {
      issue(ctx, ["threshold"], "Only the bar-bounded documentation reasons carry a threshold");
    }
  });
export type V9EvidenceGapDocumentation = z.infer<typeof V9EvidenceGapDocumentationSchema>;

/**
 * The issuer researched-terminal band (PLAN §4.3): a cause-C proof records that
 * the issuer was researched and does not publish the datum, so the item leaves
 * the default drain for a dated recheck at the proof's own research horizon.
 */
const V9EvidenceGapReviewStateSchema = z
  .object({
    state: z.literal("researched-terminal"),
    reviewedAtSec: UnixSecondsSchema,
    recheckAtSec: UnixSecondsSchema,
    trigger: z.literal("cause-proof-expiry"),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.recheckAtSec <= review.reviewedAtSec) {
      issue(ctx, ["recheckAtSec"], "A recheck must follow the review it re-examines");
    }
  });
export type V9EvidenceGapReviewState = z.infer<typeof V9EvidenceGapReviewStateSchema>;

const V9EvidenceGapQueueEntryV2Fields = {
  ...V9EvidenceGapQueueEntryV1Fields,
  responsibility: V9EvidenceResponsibilitySchema,
  cause: V9EvidenceCauseSchema,
  causeProof: V9EvidenceCauseProofSchema,
  causeScope: V9EvidenceCauseScopeSchema.nullable(),
  causeGapIds: CanonicalStringArraySchema.min(1),
  /** Present only on bridge-scoped gaps; null everywhere else. */
  bridgeJoin: V9EvidenceGapBridgeJoinV1Schema.nullable(),
} as const;

type V9EvidenceGapQueueEntryV2Base = z.infer<z.ZodObject<typeof V9EvidenceGapQueueEntryV2Fields>>;

function addEntryProofConsistencyIssues(entry: V9EvidenceGapQueueEntryV2Base, ctx: z.RefinementCtx): void {
  addEntryConsistencyIssues(entry, ctx);
  if (entry.cause !== entry.causeProof.cause ||
      entry.responsibility !== v9EvidenceResponsibilityForCauseProof(entry.causeProof) ||
      !entry.causeGapIds.includes(entry.gapId) ||
      entry.causeProof.evidenceRefIds.some((id) => !entry.evidenceRefIds.includes(id)) ||
      ((entry.cause === "A" || entry.cause === "B") && (entry.critical || entry.treatment !== "diagnostic")) ||
      ((entry.cause === "C" || entry.cause === "U") && entry.treatment === "NR") ||
      ((entry.cause === "A" || entry.cause === "B" || entry.cause === "C") && entry.causeScope === null)) {
    ctx.addIssue({ code: "custom", message: "Queue responsibility, critical treatment and exact causal identity must match the proof" });
  }
}

const V9EvidenceGapQueueEntryV2Schema = z
  .object(V9EvidenceGapQueueEntryV2Fields)
  .strict()
  .superRefine(addEntryProofConsistencyIssues);
export type V9EvidenceGapQueueEntryV2 = z.infer<typeof V9EvidenceGapQueueEntryV2Schema>;

const V9EvidenceGapQueueEntryV3Schema = z
  .object({
    ...V9EvidenceGapQueueEntryV2Fields,
    /** Documentation band; null for open and issuer work. */
    documentation: V9EvidenceGapDocumentationSchema.nullable(),
    /** Issuer band; null for open and documentation work (precedence documentation > issuer). */
    reviewState: V9EvidenceGapReviewStateSchema.nullable(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    addEntryProofConsistencyIssues(entry, ctx);
    if (entry.documentation !== null) {
      if (entry.cause !== "C" && entry.cause !== "U") {
        issue(ctx, ["documentation"], "Only a compiled cause-C/U gap can be documentation");
      }
      if (entry.reviewState !== null) {
        issue(ctx, ["reviewState"], "Documentation work never joins the issuer band");
      }
    }
    if (entry.reviewState === null) return;
    const proof = entry.causeProof;
    if (proof.cause !== "C" || proof.assertion !== "researched-nondisclosure") {
      issue(ctx, ["reviewState"], "A researched-terminal recheck requires an issuer-nondisclosure proof");
    } else if (entry.reviewState.reviewedAtSec !== Math.floor(parseIsoDateOrUtcInstantSec(proof.reviewedAt))) {
      issue(ctx, ["reviewState", "reviewedAtSec"], "The recheck band must carry the proof's own review date");
    }
  });
export type V9EvidenceGapQueueEntryV3 = z.infer<typeof V9EvidenceGapQueueEntryV3Schema>;

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
    sourceSchemaVersion: z.literal(4),
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
      issue(ctx, ["evaluationFactSetDigest"], "Current proof-bearing source and evaluation fact-set digests must match");
    }
  });

const V9EvidenceGapQueueCoreV2Fields = {
  schemaVersion: z.literal(3),
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

type V9EvidenceGapQueueResponsibilityValue = {
  summary: { responsibilityCounts: readonly { responsibility: z.infer<typeof V9EvidenceResponsibilitySchema>; count: number }[] };
  entries: readonly { responsibility: z.infer<typeof V9EvidenceResponsibilitySchema> }[];
};

function addResponsibilityConsistencyIssues(
  queue: V9EvidenceGapQueueResponsibilityValue,
  ctx: z.RefinementCtx,
): void {
  const expectedResponsibilities = [...V9EvidenceResponsibilitySchema.options].sort(compareText);
  const actualResponsibilities = queue.summary.responsibilityCounts.map((entry) => entry.responsibility);
  addCanonicalStringArrayIssues(actualResponsibilities, ctx, ["summary", "responsibilityCounts"]);
  if (JSON.stringify(actualResponsibilities) !== JSON.stringify(expectedResponsibilities)) {
    issue(ctx, ["summary", "responsibilityCounts"], "Responsibility counts must distinguish every registered responsibility");
  }
  const counts = new Map(expectedResponsibilities.map((responsibility) => [responsibility, 0]));
  for (const entry of queue.entries) {
    counts.set(entry.responsibility, (counts.get(entry.responsibility) ?? 0) + 1);
  }
  for (const entry of queue.summary.responsibilityCounts) {
    if (entry.count !== counts.get(entry.responsibility)) {
      issue(ctx, ["summary", "responsibilityCounts"], `Count mismatch for ${entry.responsibility}`);
    }
  }
}

function addQueueV2ConsistencyIssues(
  queue: z.infer<z.ZodObject<typeof V9EvidenceGapQueueCoreV2Fields>>,
  ctx: z.RefinementCtx,
): void {
  addQueueConsistencyIssues(queue, ctx);
  addResponsibilityConsistencyIssues(queue, ctx);
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

const V9EvidenceGapDocumentationReasonCountSchema = z
  .object({
    reason: V9DocumentationReasonSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Documentation-band totals. `documentationGapCount` counts queue datums, not
 * questions: every documentation entry stays in `entries` and stays addressable.
 */
const V9EvidenceGapQueueSummaryV3Fields = {
  ...V9EvidenceGapQueueSummaryV1Fields,
  responsibilityCounts: z.array(V9EvidenceResponsibilityCountSchema),
  documentationGapCount: z.number().int().nonnegative(),
  researchedTerminalGapCount: z.number().int().nonnegative(),
  documentationReasonCounts: z.array(V9EvidenceGapDocumentationReasonCountSchema),
} as const;

const V9EvidenceGapQueueCoreV3Fields = {
  schemaVersion: z.literal(4),
  purpose: z.literal("evidence-work-queue-not-release-gate"),
  status: z.enum(["clear", "work-required"]),
  facts: V9EvidenceGapQueueFactsV2Schema,
  policy: z.object({ policyId: CanonicalTextSchema, semanticDigest: Sha256Schema }).strict(),
  summary: z.object(V9EvidenceGapQueueSummaryV3Fields).strict(),
  entries: z.array(V9EvidenceGapQueueEntryV3Schema),
} as const;

type V9EvidenceGapQueueConsistencyValueV3 = z.infer<z.ZodObject<typeof V9EvidenceGapQueueCoreV3Fields>>;

function addQueueV3ConsistencyIssues(queue: V9EvidenceGapQueueConsistencyValueV3, ctx: z.RefinementCtx): void {
  addQueueConsistencyIssues(queue, ctx);
  addResponsibilityConsistencyIssues(queue, ctx);

  const documentationEntries = queue.entries.filter((entry) => entry.documentation !== null);
  if (queue.summary.documentationGapCount !== documentationEntries.length) {
    issue(ctx, ["summary", "documentationGapCount"], `Expected ${documentationEntries.length}`);
  }
  const researchedTerminalCount = queue.entries.filter((entry) => entry.reviewState !== null).length;
  if (queue.summary.researchedTerminalGapCount !== researchedTerminalCount) {
    issue(ctx, ["summary", "researchedTerminalGapCount"], `Expected ${researchedTerminalCount}`);
  }
  const expectedReasons = V9DocumentationReasonSchema.options;
  const actualReasons = queue.summary.documentationReasonCounts.map((entry) => entry.reason);
  if (JSON.stringify(actualReasons) !== JSON.stringify(expectedReasons)) {
    issue(ctx, ["summary", "documentationReasonCounts"], "Documentation counts must list every reason once, in vocabulary order");
  }
  const counts = new Map<string, number>(expectedReasons.map((reason) => [reason, 0]));
  for (const entry of documentationEntries) {
    const reason = entry.documentation!.reason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  for (const entry of queue.summary.documentationReasonCounts) {
    if (entry.count !== counts.get(entry.reason)) {
      issue(ctx, ["summary", "documentationReasonCounts"], `Count mismatch for ${entry.reason}`);
    }
  }
}

const V9EvidenceGapQueueCoreObjectV3Schema = z.object(V9EvidenceGapQueueCoreV3Fields).strict();
export const V9EvidenceGapQueueCoreV3Schema =
  V9EvidenceGapQueueCoreObjectV3Schema.superRefine(addQueueV3ConsistencyIssues);
export type V9EvidenceGapQueueCoreV3 = z.infer<typeof V9EvidenceGapQueueCoreV3Schema>;

export const V9EvidenceGapQueueV3Schema = z
  .object({ ...V9EvidenceGapQueueCoreV3Fields, queueDigest: Sha256Schema })
  .strict()
  .superRefine(addQueueV3ConsistencyIssues);
export type V9EvidenceGapQueueV3 = z.infer<typeof V9EvidenceGapQueueV3Schema>;

export type V9EvidenceGapQueue = V9EvidenceGapQueueV1 | V9EvidenceGapQueueV2 | V9EvidenceGapQueueV3;
