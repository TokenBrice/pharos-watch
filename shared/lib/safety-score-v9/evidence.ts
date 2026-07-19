import {
  V9EvidenceReferenceV2Schema,
  V9FactStatusV2Schema,
  type V9EvidenceReferenceV2,
  type V9FactApplicability,
  type V9FactStatusV2,
  type V9ObservationState,
} from "../../types/safety-score-v9-facts";

/**
 * Reviewed research evidence (bridge-route, mint-authority, and oracle
 * reviews, plus route output valuations) stays current on the D11 review
 * cadence: 365 days, the same window D11 ratified for access evidence and the
 * documentedTermsMaxAgeSec precedent.
 */
export const V9_REVIEW_EVIDENCE_MAX_AGE_SEC = 31_536_000;

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
  });
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
