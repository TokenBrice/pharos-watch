import {
  V9EvidenceReferenceV2Schema,
  V9FactStatusV2Schema,
  type V9EvidenceReferenceV2,
  type V9EvidenceResponsibility,
  type V9FactApplicability,
  type V9FactStatusV2,
  type V9ObservationState,
  type V9AssetFactsV3,
} from "../../types/safety-score-v9-facts";
import { V9_CANDIDATE_POLICY_V1 } from "./policy";
import {
  V9EvidenceCauseProofSchema, V9EvidenceGapClassificationSchema, V9RuntimeProducerVerdictSchema,
  V9TypedReviewGapClassificationSchema,
  V9_UNRESEARCHED_CAUSE_PROOF, findV9EvidenceCauseProofIssues,
  v9EvidenceCauseScopeKey, v9EvidenceResponsibilityForCauseProof,
  type V9EvidenceCauseBindingSchema, type V9EvidenceCauseProof, type V9EvidenceCauseScope,
  type V9EvidenceGapClassification, type V9RuntimeProducerVerdict,
  type V9TypedReviewGapClassification, type V9CauseResolutionDiagnostic,
} from "../../types/safety-score-v9-causes";
import type { z } from "zod";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

/**
 * Reviewed research evidence (bridge-route, mint-authority, and oracle
 * reviews, plus route output valuations) stays current on the D11 review
 * cadence: 365 days, the same window D11 ratified for access evidence and the
 * documentedTermsMaxAgeSec precedent.
 */
export const V9_REVIEW_EVIDENCE_MAX_AGE_SEC =
  V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;

/** Freshness of a scoped research question is independent of its bounded cause treatment. */
export const V9_SCOPED_QUESTION_MAX_AGE_SEC = 90 * 24 * 60 * 60;

export interface CreateV9EvidenceReferenceArgs {
  evidenceId: string;
  sourceId: string;
  sourceGenerationId: string;
  disposition: "observed" | "published" | "rejected";
  observedAtSec: number;
  publishedAtSec?: number | null;
  url?: string | null;
  contentSha256?: string | null;
  maxAgeSec?: number | null;
  rejection?: { code: string; reason: string; rejectedAtSec: number } | null;
  causeBinding?: z.infer<typeof V9EvidenceCauseBindingSchema>;
}

/** Builds one clock-derived evidence reference without consulting wall time. */
export function createV9EvidenceReference(args: CreateV9EvidenceReferenceArgs, asOfSec: number): V9EvidenceReferenceV2 {
  if (!Number.isInteger(asOfSec) || asOfSec < 0) throw new Error("asOfSec must be a non-negative integer");
  if (!Number.isInteger(args.observedAtSec) || args.observedAtSec < 0 || args.observedAtSec > asOfSec) {
    throw new Error(`Evidence ${args.evidenceId} observation is later than asOfSec or invalid`);
  }
  if (args.publishedAtSec != null && args.publishedAtSec > asOfSec) {
    throw new Error(`Evidence ${args.evidenceId} publication is later than asOfSec`);
  }
  if (args.rejection && args.rejection.rejectedAtSec > asOfSec) {
    throw new Error(`Evidence ${args.evidenceId} rejection is later than asOfSec`);
  }
  const ageSec = asOfSec - args.observedAtSec;
  const maxAgeSec = args.maxAgeSec ?? null;
  const freshness =
    maxAgeSec === null
      ? { state: "not-assessed" as const, ageSec, maxAgeSec }
      : { state: ageSec <= maxAgeSec ? ("current" as const) : ("stale" as const), ageSec, maxAgeSec };
  return V9EvidenceReferenceV2Schema.parse({
    evidenceId: args.evidenceId,
    sourceId: args.sourceId,
    sourceGenerationId: args.sourceGenerationId,
    disposition: args.disposition,
    observedAtSec: args.observedAtSec,
    publishedAtSec: args.publishedAtSec ?? null,
    url: args.url ?? null,
    contentSha256: args.contentSha256 ?? null,
    freshness,
    rejection: args.rejection ?? null,
    ...(args.causeBinding === undefined ? {} : { causeBinding: args.causeBinding }),
  });
}

/** Historical publisher metadata is retained independently of admitted scoring causes. */
export type V9PublishedEvidenceAttribution = "issuer" | "parent" | "other" | "unknown";


function createReviewedClassificationEvidence(
  entry: V9EvidenceGapClassification | V9TypedReviewGapClassification,
  asOfSec: number,
  origin: "registry" | "typed-review",
): V9EvidenceReferenceV2 {
  const contentSha256 = sha256Hex(stableJsonStringifyV1(entry));
  const prefix = origin === "registry" ? "evidence-gap-classification" : "typed-review-gap-classification";
  return createV9EvidenceReference({
    evidenceId: `${prefix}:${entry.id}:${contentSha256}`,
    sourceId: origin === "registry" ? "evidence-gap-classifications-v1" : "typed-review-gap-classifications-v1",
    sourceGenerationId: entry.id, disposition: "published",
    observedAtSec: Date.parse(entry.reviewedAt) / 1000, publishedAtSec: Date.parse(entry.reviewedAt) / 1000,
    url: entry.sources[0]!.url, contentSha256, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
    causeBinding: { assetId: entry.assetId, scope: entry.scope, producerState: null, rejectionCode: null, adverseFactId: null },
  }, asOfSec);
}

/** Registry research remains timestamp-strict and distinct from legacy dated reviews. */
export function createV9ClassificationEvidence(classification: V9EvidenceGapClassification, asOfSec: number): V9EvidenceReferenceV2 {
  return createReviewedClassificationEvidence(V9EvidenceGapClassificationSchema.parse(classification), asOfSec, "registry");
}
export function createV9TypedReviewEvidence(classification: V9TypedReviewGapClassification, asOfSec: number): V9EvidenceReferenceV2 {
  return createReviewedClassificationEvidence(V9TypedReviewGapClassificationSchema.parse(classification), asOfSec, "typed-review");
}

export interface V9ResolvedEvidenceCause {
  causeProof: V9EvidenceCauseProof;
  responsibility: V9EvidenceResponsibility;
  evidenceReferences: readonly V9EvidenceReferenceV2[];
  diagnostics?: readonly V9CauseResolutionDiagnostic[];
}

/** One cause resolver: admitted D, exact-generation A, current scoped B/C, otherwise U. */
export function resolveV9EvidenceCause(args: {
  assetId: string;
  scope: V9EvidenceCauseScope;
  asOfSec: number;
  sourceGenerationId: string;
  evidenceReferences: readonly V9EvidenceReferenceV2[];
  runtimeVerdict?: V9RuntimeProducerVerdict | null;
  classification?: V9EvidenceGapClassification | null;
  typedReview?: unknown;
  adverseProof?: Extract<V9EvidenceCauseProof, { cause: "D" }> | null;
}): V9ResolvedEvidenceCause {
  let causeProof: V9EvidenceCauseProof = V9_UNRESEARCHED_CAUSE_PROOF;
  let evidenceReferences = args.evidenceReferences;
  let diagnostics: V9CauseResolutionDiagnostic[] | undefined;
  let optionalResearch = false;
  if (args.adverseProof) {
    causeProof = V9EvidenceCauseProofSchema.parse(args.adverseProof);
  } else if (args.runtimeVerdict) {
    const verdict = V9RuntimeProducerVerdictSchema.parse(args.runtimeVerdict);
    if (v9EvidenceCauseScopeKey(verdict.assetId, verdict.scope) !== v9EvidenceCauseScopeKey(args.assetId, args.scope)) {
      throw new Error("Pipeline cause has wrong asset or required-datum scope");
    }
    causeProof = verdict.proof;
  } else if (args.classification != null || args.typedReview != null) {
    optionalResearch = true;
    try {
      const typed = args.classification == null;
      const entry = typed ? V9TypedReviewGapClassificationSchema.parse(args.typedReview)
        : V9EvidenceGapClassificationSchema.parse(args.classification);
      if (v9EvidenceCauseScopeKey(entry.assetId, entry.scope, "research") !== v9EvidenceCauseScopeKey(args.assetId, args.scope, "research")) {
        throw new Error("Research proof has wrong asset or required-datum scope");
      }
      const reviewedSec = Date.parse(entry.reviewedAt) / 1000;
      if (reviewedSec + (typed ? 86400 : 0) > args.asOfSec) throw new Error("Research review is not yet admitted by its clock");
      if (args.asOfSec - reviewedSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) throw new Error("Research review has expired");
      const evidence = createReviewedClassificationEvidence(entry, args.asOfSec, typed ? "typed-review" : "registry");
      evidenceReferences = [...evidenceReferences.filter((ref) => ref.evidenceId !== evidence.evidenceId), evidence];
      causeProof = V9EvidenceCauseProofSchema.parse({
        cause: entry.cause, classificationId: entry.id, reviewedAt: entry.reviewedAt,
        ...(entry.reviewer === undefined ? {} : { reviewer: entry.reviewer }),
        ...(typed ? { proofOrigin: "typed-review" } : {}),
        assertion: entry.assertion, sources: entry.sources, evidenceRefIds: [evidence.evidenceId],
        ...(entry.cause === "C" ? { rationale: entry.rationale,
          ...(entry.searchedSurfaces === undefined ? {} : { searchedSurfaces: entry.searchedSurfaces }) } : {}),
      });
    } catch (error) {
      causeProof = V9_UNRESEARCHED_CAUSE_PROOF;
      evidenceReferences = args.evidenceReferences;
      diagnostics = [{ code: "cause-proof-conversion-failed", scope: args.scope,
        message: error instanceof Error && error.message.trim() ? error.message : "Optional research proof conversion failed" }];
    }
  }
  const errors = findV9EvidenceCauseProofIssues({
    proof: causeProof, assetId: args.assetId, scope: args.scope, asOfSec: args.asOfSec,
    sourceGenerationId: args.sourceGenerationId, evidence: evidenceReferences,
    researchMaxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  if (errors.length > 0) {
    if (!optionalResearch) throw new Error(errors.join("; "));
    causeProof = V9_UNRESEARCHED_CAUSE_PROOF;
    evidenceReferences = args.evidenceReferences;
    diagnostics = [{ code: "cause-proof-conversion-failed", scope: args.scope, message: errors.join("; ") }];
  }
  return { causeProof, responsibility: v9EvidenceResponsibilityForCauseProof(causeProof), evidenceReferences,
    ...(diagnostics === undefined ? {} : { diagnostics }) };
}

/** Asset-local binding validation uses the captured evidence clock; cohort admission independently binds the root clock. */
export function findV9CauseEvidenceBindingIssues(
  asset: Pick<V9AssetFactsV3, "assetId" | "gaps" | "evidence">,
): { gapIndex: number; message: string }[] {
  const issues: { gapIndex: number; message: string }[] = [];
  let evidenceById: Map<string, V9EvidenceReferenceV2> | undefined;
  let classificationDigests: Map<string, string> | undefined;
  const firstReference = asset.evidence[0];
  const asOfSec = firstReference ? firstReference.observedAtSec + firstReference.freshness.ageSec : 0;
  for (const [gapIndex, gap] of asset.gaps.entries()) {
    const proof = gap.causeProof;
    if (proof.cause === "U" && (gap.evidenceHistory?.evidenceRefIds.length ?? 0) === 0) continue;
    if (!evidenceById) {
      evidenceById = new Map();
      for (const reference of asset.evidence) evidenceById.set(reference.evidenceId, reference);
    }
    for (const id of gap.evidenceHistory?.evidenceRefIds ?? []) {
      if (!evidenceById.has(id)) issues.push({ gapIndex, message: `Unknown historical evidence reference ${id}` });
    }
    if (proof.cause === "U") continue;
    for (const message of findV9EvidenceCauseProofIssues({
      proof, assetId: asset.assetId, scope: gap.causeScope ?? null, evidence: asset.evidence, evidenceById,
      asOfSec, researchMaxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
    })) issues.push({ gapIndex, message });
    if (proof.cause !== "B" && proof.cause !== "C") continue;
    if (!gap.causeScope) continue;
    classificationDigests ??= new Map();
    const identity = `${proof.proofOrigin ?? "registry"}:${proof.classificationId}`;
    const reviewedSec = Date.parse(proof.reviewedAt) / 1000;
    const sourceId = proof.proofOrigin === "typed-review" ? "typed-review-gap-classifications-v1" : "evidence-gap-classifications-v1";
    const prefix = proof.proofOrigin === "typed-review" ? "typed-review-gap-classification" : "evidence-gap-classification";
    for (const id of proof.evidenceRefIds) {
      const reference = evidenceById.get(id);
      // Hash the authored binding, not the current gap's rotating route generation.
      // Scope admission above still requires the same stable research identity.
      if (!reference?.causeBinding) {
        issues.push({ gapIndex, message: "Authored classification evidence requires its authored scope" });
        continue;
      }
      const digest = sha256Hex(stableJsonStringifyV1({
        id: proof.classificationId, assetId: asset.assetId, scope: reference.causeBinding.scope,
        cause: proof.cause, reviewedAt: proof.reviewedAt, ...(proof.reviewer === undefined ? {} : { reviewer: proof.reviewer }),
        assertion: proof.assertion, sources: proof.sources,
        ...(proof.cause === "C" ? { rationale: proof.rationale,
          ...(proof.searchedSurfaces === undefined ? {} : { searchedSurfaces: proof.searchedSurfaces }) } : {}),
      }));
      const previous = classificationDigests.get(identity);
      if (previous !== undefined && previous !== digest) {
        issues.push({ gapIndex, message: "One classification identity cannot certify contradictory authored bytes" });
      }
      classificationDigests.set(identity, digest);
      if (reference.sourceId !== sourceId ||
          reference.contentSha256 !== digest || reference.sourceGenerationId !== proof.classificationId ||
          id !== `${prefix}:${proof.classificationId}:${digest}` ||
          reference.observedAtSec !== reviewedSec || reference.publishedAtSec !== reviewedSec ||
          reference.url !== proof.sources[0]!.url) {
        issues.push({ gapIndex, message: "Authored classification evidence must bind its normalized source/assertion/date bytes" });
      }
    }
  }
  return issues;
}

export function createV9FactStatus(args: {
  applicability: V9FactApplicability;
  observationState: V9ObservationState;
  evidenceRefIds?: readonly string[];
  gapIds?: readonly string[];
}): V9FactStatusV2 {
  return V9FactStatusV2Schema.parse({
    applicability: args.applicability,
    observationState: args.observationState,
    evidenceRefIds: [...(args.evidenceRefIds ?? [])],
    gapIds: [...(args.gapIds ?? [])],
  });
}

export function requiredV9Applicability(policyRuleId: string): V9FactApplicability {
  return { state: "required", policyRuleId, rationale: null, gapId: null };
}

export function notApplicableV9Fact(policyRuleId: string, rationale: string): V9FactApplicability {
  return { state: "not-applicable", policyRuleId, rationale, gapId: null };
}

export function unresolvedV9Applicability(policyRuleId: string, rationale: string, gapId: string): V9FactApplicability {
  return { state: "unresolved", policyRuleId, rationale, gapId };
}
