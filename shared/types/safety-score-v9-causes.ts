import { z } from "zod";
import { CanonicalKeySchema, CanonicalTextSchema, ScoreSchema, StrictIsoDateSchema, UnixSecondsSchema } from "./safety-schema-primitives";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";

export const V9EvidenceCauseSchema = z.enum(["A", "B", "C", "U", "D"]);
export type V9EvidenceCause = z.infer<typeof V9EvidenceCauseSchema>;
const V9EvidenceProducerStateSchema = z.enum([
  "producer-failed", "integration-missing", "config-mismatch", "stale-producer", "unsupported-reader",
]);
export const V9EvidenceCauseScopeSchema = z.object({
  pillar: z.enum(["backing", "exit", "control"]),
  componentKey: CanonicalTextSchema,
  factorKey: CanonicalTextSchema.nullable(),
  routeKey: CanonicalTextSchema.nullable(),
  exposureId: CanonicalTextSchema.nullable(),
  requiredDatum: CanonicalTextSchema,
}).strict();
export type V9EvidenceCauseScope = z.infer<typeof V9EvidenceCauseScopeSchema>;

const HttpUrlSchema = z.string().url().refine((url) => /^https?:\/\//u.test(url), "Primary source must use HTTP(S)");
const V9ResearchTimestampSchema = z.string().datetime({ precision: 0 });
const V9EvidenceClassificationSourceSchema = z.object({
  url: HttpUrlSchema,
  observedAt: V9ResearchTimestampSchema,
  datumAsOf: z.union([StrictIsoDateSchema, V9ResearchTimestampSchema]).nullable(),
  location: CanonicalTextSchema,
  excerpt: CanonicalTextSchema,
  assertion: CanonicalTextSchema,
}).strict();
const V9TypedReviewClassificationSourceSchema = z.object({
  url: HttpUrlSchema,
  observedAt: z.union([StrictIsoDateSchema, V9ResearchTimestampSchema]).optional(),
  datumAsOf: z.union([StrictIsoDateSchema, V9ResearchTimestampSchema]).nullable().optional(),
  location: CanonicalTextSchema.optional(),
  excerpt: CanonicalTextSchema.optional(),
  assertion: CanonicalTextSchema.optional(),
}).strict();
export const V9CauseResolutionDiagnosticSchema = z.object({
  code: z.literal("cause-proof-conversion-failed"),
  scope: V9EvidenceCauseScopeSchema,
  message: CanonicalTextSchema,
}).strict();
export type V9CauseResolutionDiagnostic = z.infer<typeof V9CauseResolutionDiagnosticSchema>;
const AuthoredFields = {
  classificationId: CanonicalTextSchema,
  proofOrigin: z.literal("typed-review").optional(),
  reviewedAt: z.union([V9ResearchTimestampSchema, StrictIsoDateSchema]),
  reviewer: CanonicalTextSchema.optional(),
  sources: z.array(V9TypedReviewClassificationSourceSchema).min(1),
  evidenceRefIds: canonicalTextArray(1),
};
const V9PipelineCauseProofSchema = z.object({
  cause: z.literal("A"), producerState: V9EvidenceProducerStateSchema,
  sourceId: CanonicalTextSchema, sourceGenerationId: CanonicalTextSchema,
  observedAtSec: UnixSecondsSchema, evidenceRefIds: canonicalTextArray(1), rejectionCode: CanonicalKeySchema,
}).strict();
export const V9EvidenceCauseProofSchema = z.discriminatedUnion("cause", [
  V9PipelineCauseProofSchema,
  z.object({ cause: z.literal("B"), ...AuthoredFields, assertion: z.literal("required-data-public") }).strict(),
  z.object({
    cause: z.literal("C"), ...AuthoredFields, assertion: z.literal("researched-nondisclosure"),
    searchedSurfaces: z.array(HttpUrlSchema).min(1).optional(), rationale: CanonicalTextSchema,
  }).strict(),
  z.object({ cause: z.literal("U"), reason: z.literal("not-yet-researched"), evidenceRefIds: z.tuple([]) }).strict(),
  z.object({ cause: z.literal("D"), adverseFactId: CanonicalTextSchema, evidenceRefIds: canonicalTextArray(1) }).strict(),
]).superRefine((proof, ctx) => {
  if (proof.cause !== "B" && proof.cause !== "C") return;
  if (proof.proofOrigin === "typed-review") {
    if (!StrictIsoDateSchema.safeParse(proof.reviewedAt).success) ctx.addIssue({ code: "custom", path: ["reviewedAt"], message: "Typed review retains its calendar date" });
    return;
  }
  if (!V9ResearchTimestampSchema.safeParse(proof.reviewedAt).success || proof.reviewer === undefined ||
      (proof.cause === "C" && proof.searchedSurfaces === undefined)) {
    ctx.addIssue({ code: "custom", message: "Registry proofs require timestamped authored research" });
  }
  for (const [index, source] of proof.sources.entries()) {
    if (!V9EvidenceClassificationSourceSchema.safeParse(source).success) ctx.addIssue({ code: "custom", path: ["sources", index], message: "Registry source must retain its full timestamped assertion" });
  }
});
export type V9EvidenceCauseProof = z.infer<typeof V9EvidenceCauseProofSchema>;
export const V9_UNRESEARCHED_CAUSE_PROOF: Readonly<Extract<V9EvidenceCauseProof, { cause: "U" }>> = Object.freeze({
  cause: "U", reason: "not-yet-researched", evidenceRefIds: [] as [],
});
Object.freeze(V9_UNRESEARCHED_CAUSE_PROOF.evidenceRefIds);

const ClassificationFields = {
  id: CanonicalTextSchema, assetId: CanonicalKeySchema, scope: V9EvidenceCauseScopeSchema,
  reviewedAt: V9ResearchTimestampSchema, reviewer: CanonicalTextSchema,
  sources: z.array(V9EvidenceClassificationSourceSchema).min(1),
};
export const V9EvidenceGapClassificationSchema = z.discriminatedUnion("cause", [
  z.object({ ...ClassificationFields, cause: z.literal("B"), assertion: z.literal("required-data-public") }).strict(),
  z.object({
    ...ClassificationFields, cause: z.literal("C"), assertion: z.literal("researched-nondisclosure"),
    searchedSurfaces: z.array(HttpUrlSchema).min(1), rationale: CanonicalTextSchema,
  }).strict(),
]).superRefine((entry, ctx) => {
  for (const [sourceIndex, source] of entry.sources.entries()) {
    if (Date.parse(source.observedAt) > Date.parse(entry.reviewedAt) ||
        (source.datumAsOf !== null && Date.parse(source.datumAsOf) > Date.parse(source.observedAt))) {
      ctx.addIssue({ code: "custom", path: ["sources", sourceIndex], message: "Source dates cannot postdate observation/review" });
    }
  }
});
export type V9EvidenceGapClassification = z.infer<typeof V9EvidenceGapClassificationSchema>;

const TypedReviewFields = {
  id: CanonicalTextSchema, assetId: CanonicalKeySchema, scope: V9EvidenceCauseScopeSchema,
  reviewedAt: StrictIsoDateSchema, reviewer: CanonicalTextSchema.optional(),
  sources: z.array(z.preprocess(
    (value) => typeof value === "string" ? { url: value } : value,
    V9TypedReviewClassificationSourceSchema,
  )).min(1),
};
export const V9TypedReviewGapClassificationSchema = z.discriminatedUnion("cause", [
  z.object({ ...TypedReviewFields, cause: z.literal("B"), assertion: z.literal("required-data-public") }).strict(),
  z.object({
    ...TypedReviewFields, cause: z.literal("C"), assertion: z.literal("researched-nondisclosure"),
    searchedSurfaces: z.array(HttpUrlSchema).min(1).optional(), rationale: CanonicalTextSchema,
  }).strict(),
]);
export type V9TypedReviewGapClassification = z.infer<typeof V9TypedReviewGapClassificationSchema>;

// Only publication generations admitted by the DEX/redemption producers are removable.
// Route IDs may themselves contain colons; unfamiliar route-key formats remain exact.
const ResearchDexRouteKey = /^(dex):dex-liquidity-[0-9]+:(.+)$/u;
const ResearchRedemptionRouteKey = /^(redemption):(?:redemption:(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+:[a-z0-9]{0,8})|redemption-backstops-unavailable):(.+)$/u;

/** Exact identity by default; research binds the same lane/route across producer generations. */
export function v9EvidenceCauseScopeKey(
  assetId: string,
  scope: V9EvidenceCauseScope,
  identity: "exact" | "research" = "exact",
): string {
  let routeIdentity: string | null | readonly string[] = scope.routeKey;
  if (identity === "research" && scope.routeKey !== null) {
    const match = ResearchDexRouteKey.exec(scope.routeKey) ?? ResearchRedemptionRouteKey.exec(scope.routeKey);
    if (match) routeIdentity = [match[1]!, match[2]!];
  }
  return JSON.stringify([assetId, scope.pillar, scope.componentKey, scope.factorKey, routeIdentity, scope.exposureId, scope.requiredDatum]);
}
export const V9EvidenceGapClassificationsV1Schema = z.object({
  schemaVersion: z.literal(1), entries: z.array(V9EvidenceGapClassificationSchema),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  const scopes = new Set<string>();
  registry.entries.forEach((entry, index) => {
    const scope = v9EvidenceCauseScopeKey(entry.assetId, entry.scope, "research");
    if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: "Duplicate classification ID" });
    if (scopes.has(scope)) ctx.addIssue({ code: "custom", path: ["entries", index, "scope"], message: "Duplicate or contradictory classification scope" });
    ids.add(entry.id);
    scopes.add(scope);
  });
}).transform((registry) => ({ ...registry, entries: [...registry.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }));

/** Catalog, captured scope and clock admission are required in addition to structural parsing. */
export function createV9EvidenceGapClassificationsV1Schema(context: {
  assetIds: ReadonlySet<string>;
  /** Captured scopes keyed with v9EvidenceCauseScopeKey(assetId, scope, "research"). */
  scopeKeys: ReadonlySet<string>;
  asOfSec: number;
  researchMaxAgeSec: number;
}) {
  return V9EvidenceGapClassificationsV1Schema.superRefine((registry, ctx) => {
    for (const [index, entry] of registry.entries.entries()) {
      if (!context.assetIds.has(entry.assetId)) ctx.addIssue({ code: "custom", path: ["entries", index, "assetId"], message: "Noncatalog asset identity" });
      if (!context.scopeKeys.has(v9EvidenceCauseScopeKey(entry.assetId, entry.scope, "research"))) ctx.addIssue({ code: "custom", path: ["entries", index, "scope"], message: "Unsupported or wrong captured datum scope" });
      const reviewedAtSec = Date.parse(entry.reviewedAt) / 1000;
      if (reviewedAtSec > context.asOfSec || context.asOfSec - reviewedAtSec > context.researchMaxAgeSec) {
        ctx.addIssue({ code: "custom", path: ["entries", index, "reviewedAt"], message: "Future or expired current-datum research" });
      }
    }
  });
}

export const V9EvidenceCauseBindingSchema = z.object({
  assetId: CanonicalKeySchema, scope: V9EvidenceCauseScopeSchema,
  producerState: V9EvidenceProducerStateSchema.nullable(),
  rejectionCode: CanonicalKeySchema.nullable(), adverseFactId: CanonicalTextSchema.nullable(),
}).strict();
export const V9RuntimeProducerVerdictSchema = z.object({
  assetId: CanonicalKeySchema, scope: V9EvidenceCauseScopeSchema,
  proof: V9PipelineCauseProofSchema,
}).strict();
export type V9RuntimeProducerVerdict = z.infer<typeof V9RuntimeProducerVerdictSchema>;

export function v9EvidenceResponsibilityForCauseProof(proof: V9EvidenceCauseProof) {
  if (proof.cause === "B") return "public-data-uncurated" as const;
  if (proof.cause === "C") return "issuer-undisclosed" as const;
  if (proof.cause === "U") return "unresearched" as const;
  if (proof.cause === "D") return "measured-adverse" as const;
  return proof.producerState === "integration-missing" ? "integration-missing" as const
    : proof.producerState === "unsupported-reader" ? "method-unsupported" as const
      : "producer-failed" as const;
}

export interface V9CauseProofEvidence {
  evidenceId: string;
  sourceId: string;
  sourceGenerationId: string;
  observedAtSec: number;
  disposition: "observed" | "published" | "rejected";
  freshness: { state: string };
  rejection: { code: string } | null;
  causeBinding?: z.infer<typeof V9EvidenceCauseBindingSchema>;
}

/** Admission errors are asset-local; absence of a proof is handled by the resolver as U. */
export function findV9EvidenceCauseProofIssues(args: {
  proof: V9EvidenceCauseProof;
  assetId: string;
  scope: V9EvidenceCauseScope | null;
  asOfSec: number;
  sourceGenerationId?: string;
  evidence: readonly V9CauseProofEvidence[];
  evidenceById?: ReadonlyMap<string, V9CauseProofEvidence>;
  researchMaxAgeSec: number;
}): string[] {
  const { proof, scope } = args;
  if (proof.cause === "U") return [];
  const errors: string[] = [];
  let evidenceById = args.evidenceById;
  if (!evidenceById) {
    const index = new Map<string, V9CauseProofEvidence>();
    for (const reference of args.evidence) index.set(reference.evidenceId, reference);
    evidenceById = index;
  }
  if (proof.cause !== "D" && scope === null) errors.push("Cause proof requires an exact datum scope");
  const scopeIdentity = proof.cause === "B" || proof.cause === "C" ? "research" : "exact";
  for (const id of proof.evidenceRefIds) {
    const ref = evidenceById.get(id);
    if (!ref) {
      errors.push("Cause proof references missing captured evidence");
      continue;
    }
    const binding = ref.causeBinding;
    if (ref.observedAtSec > args.asOfSec) errors.push("Cause evidence is future-dated");
    if (!binding || binding.assetId !== args.assetId ||
        (scope !== null && v9EvidenceCauseScopeKey(binding.assetId, binding.scope, scopeIdentity) !== v9EvidenceCauseScopeKey(args.assetId, scope, scopeIdentity))) {
      errors.push("Cause evidence has wrong asset or required-datum scope");
    }
    if (proof.cause === "A" && (ref.sourceId !== proof.sourceId || ref.sourceGenerationId !== proof.sourceGenerationId ||
        ref.observedAtSec !== proof.observedAtSec || binding?.producerState !== proof.producerState ||
        binding?.rejectionCode !== proof.rejectionCode ||
        (ref.rejection?.code !== proof.rejectionCode && !(proof.producerState === "stale-producer" && ref.freshness.state === "stale")))) {
      errors.push("Pipeline cause lacks its exact captured attempt or reader verdict");
    }
    if (proof.cause === "D" && (ref.disposition !== "observed" || ref.rejection !== null || binding?.adverseFactId !== proof.adverseFactId)) {
      errors.push("Adverse cause requires an admitted measured adverse fact");
    }
    if ((proof.cause === "B" || proof.cause === "C") && (ref.disposition !== "published" || ref.sourceGenerationId !== proof.classificationId)) {
      errors.push("Authored cause evidence must bind the classification identity");
    }
  }
  if (proof.cause === "A" && (proof.observedAtSec > args.asOfSec ||
      (args.sourceGenerationId !== undefined && proof.sourceGenerationId !== args.sourceGenerationId))) {
    errors.push("Pipeline cause has wrong generation or future clock");
  }
  if (proof.cause === "B" || proof.cause === "C") {
    const reviewedSec = Date.parse(proof.reviewedAt) / 1000;
    const admissionSec = reviewedSec + (proof.proofOrigin === "typed-review" ? 86400 : 0);
    if (admissionSec > args.asOfSec || args.asOfSec - reviewedSec > args.researchMaxAgeSec) errors.push("Future or expired research cause");
    for (const source of proof.sources) {
      const observed = source.observedAt === undefined ? null : Date.parse(source.observedAt);
      const reviewBound = proof.proofOrigin === "typed-review" ? (reviewedSec + 86400) * 1000 - 1 : reviewedSec * 1000;
      if ((observed !== null && (observed > args.asOfSec * 1000 || observed > reviewBound)) ||
          (source.datumAsOf != null && Date.parse(source.datumAsOf) > (observed ?? reviewBound))) errors.push("Invalid research source clocks");
    }
  }
  return errors;
}

export const V9ScoringDispositionSchema = z.enum([
  "included", "excluded-pipeline", "excluded-uncurated", "bounded-uncertainty", "measured-adverse", "not-applicable",
]);
export type V9ScoringDisposition = z.infer<typeof V9ScoringDispositionSchema>;
const V9CauseContributionShape = {
  cause: V9EvidenceCauseSchema.nullable(), causeGapIds: canonicalTextArray(),
  scoringDisposition: V9ScoringDispositionSchema, effectiveScoringWeight: z.number().finite().min(0).max(1),
};
/** Compact public weights: excluded diagnostics are zero; a full scored contribution is one. */
export function resolveV9EffectiveScoringWeight(value: {
  effectiveScoringWeight?: number; scoringDisposition?: V9ScoringDisposition;
}): number {
  if (value.effectiveScoringWeight !== undefined) return value.effectiveScoringWeight;
  return value.scoringDisposition === "excluded-pipeline" || value.scoringDisposition === "excluded-uncurated" ||
    value.scoringDisposition === "not-applicable" ? 0 : 1;
}
export function refineV9CauseContribution(value: {
  cause?: V9EvidenceCause | null; causeGapIds?: readonly unknown[]; causeGapRefs?: readonly number[]; score: number | null;
  effectiveScoringWeight?: number; scoringDisposition?: V9ScoringDisposition;
}, ctx: Pick<z.RefinementCtx, "addIssue">): void {
  const cause = value.cause ?? null;
  const disposition = value.scoringDisposition ?? "included";
  const gapCount = value.causeGapIds?.length ?? value.causeGapRefs?.length ?? 0;
  const excluded = disposition === "excluded-pipeline" || disposition === "excluded-uncurated";
  const weight = resolveV9EffectiveScoringWeight(value);
  if ((excluded && (value.score !== null || weight !== 0 || gapCount === 0)) ||
      (disposition === "not-applicable" && (value.score !== null || weight !== 0)) ||
      (!excluded && disposition !== "not-applicable" && value.score === null)) {
    ctx.addIssue({ code: "custom", message: "Only excluded/not-applicable factors may be null; diagnostic quality weight is zero" });
  }
  if ((disposition === "excluded-pipeline" && cause !== "A") ||
      (disposition === "excluded-uncurated" && cause !== "B") ||
      (disposition === "bounded-uncertainty" && cause !== "C" && cause !== "U") ||
      (disposition === "measured-adverse" && cause !== "D") ||
      (disposition === "included" && cause !== null)) {
    ctx.addIssue({ code: "custom", message: "Scoring disposition must agree with controlling cause" });
  }
  if ((cause === "C" || cause === "U") && gapCount === 0) {
    ctx.addIssue({ code: "custom", message: "Included bounded uncertainty must reference its causal gaps" });
  }
}
export const V9CauseContributionSchema = z.object({ ...V9CauseContributionShape, score: ScoreSchema.nullable() }).strict()
  .superRefine(refineV9CauseContribution);
export type V9CauseContribution = z.infer<typeof V9CauseContributionSchema>;

type V9ConfidenceFactor = {
  factor: number;
  cause: V9EvidenceCause | null;
  causeGapIds: string[];
};
export type V9ConfidenceDimensions = {
  observation: V9ConfidenceFactor;
  model: V9ConfidenceFactor;
  capacityMethod: V9ConfidenceFactor;
};

export const V9RatingStatusSchema = z.enum(["rated", "not-rated", "pipeline-gap"]);
export type V9RatingStatus = z.infer<typeof V9RatingStatusSchema>;
const V9PartialEvidenceSchema = z.object({
  reasonCode: z.literal("partial-evidence-pipeline-gap"),
  excludedPillars: canonicalTextArray().pipe(z.array(z.enum(["backing", "exit", "control"]))),
  excludedComponentKeys: canonicalTextArray(), causeGapIds: canonicalTextArray(1),
  causes: canonicalTextArray(1).pipe(z.array(V9EvidenceCauseSchema.extract(["A", "B"]))),
}).strict();
export type V9PartialEvidence = z.infer<typeof V9PartialEvidenceSchema>;
export const V9PillarAggregationDispositionSchema = z.enum(["included", "excluded-a-b"]);
export const V9CompactPartialEvidenceSchema = V9PartialEvidenceSchema.pick({
  reasonCode: true, excludedPillars: true, causes: true,
});
export type V9CompactPartialEvidence = z.infer<typeof V9CompactPartialEvidenceSchema>;

export function projectV9CompactPartialEvidence(partial: Pick<V9PartialEvidence, "reasonCode" | "excludedPillars" | "causes"> | null): V9CompactPartialEvidence | null {
  return partial === null ? null : { reasonCode: partial.reasonCode, excludedPillars: partial.excludedPillars, causes: partial.causes };
}


/** Shared full-card/thin projection invariant: technical null is never the NR grade. */
export function refineV9RatingStatusFields(value: {
  ratingStatus: V9RatingStatus;
  score: number | null;
  grade: string | null;
  partialEvidence: Pick<V9PartialEvidence, "excludedPillars"> | null;
}, ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void }): void {
  const excluded = value.partialEvidence?.excludedPillars.length ?? 0;
  if ((value.ratingStatus === "pipeline-gap") !== (value.grade === null) ||
      (value.ratingStatus === "rated") !== (value.score !== null) ||
      (value.ratingStatus === "not-rated") !== (value.grade === "NR") ||
      (value.ratingStatus === "pipeline-gap") !== (excluded >= 2)) {
    ctx.addIssue({ code: "custom", message: "Rating status, grade, score and excluded-pillar coverage must agree" });
  }
}
