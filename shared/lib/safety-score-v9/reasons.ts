import {
  V9FactGapV2Schema,
  V9FactGapV3Schema,
  V9TypedFactPathSchema,
  type V9EvidenceReferenceV2,
  type V9EvidenceResponsibility,
  type V9FactGapV2,
  type V9FactGapV3,
  type V9ObservationState,
  type V9TypedFactPath,
} from "../../types/safety-score-v9-facts";
import type { V9ReasonCode, V9ReasonOwnerDomain } from "../../types/safety-score-v9";
import { compareText, uniqueSorted } from "./primitives";
import {
  type V9PublishedEvidenceAttribution,
} from "./evidence";
import {
  V9_UNRESEARCHED_CAUSE_PROOF, v9EvidenceResponsibilityForCauseProof,
  type V9EvidenceCauseProof, type V9EvidenceCauseScope, type V9EvidenceCause,
} from "../../types/safety-score-v9-causes";
import { stableJsonStringifyV1 } from "../stable-json";

export interface V9PublicReason {
  code: V9ReasonCode;
  path: string;
  message: string;
  responsibility: V9EvidenceResponsibility;
  sourceGapId?: string | null;
  cause?: V9EvidenceCause;
  causeGapIds?: readonly string[];
  causeProof?: V9EvidenceCauseProof;
}

export interface V9CanonicalReasonOptions {
  dedupeSourceGapIds?: boolean;
  conflictSubject?: string;
}

/** Canonicalize public reason identity at the evaluator/scorer seam. */
export function canonicalizeV9PublicReasons<T extends V9PublicReason>(
  reasons: readonly T[],
  options: V9CanonicalReasonOptions = {},
): T[] {
  const proofIdentities = new Map<string, string>();
  for (const reason of reasons) {
    const proof = stableJsonStringifyV1({ cause: reason.cause ?? "U", proof: reason.causeProof ?? null });
    for (const key of [`public:${reason.code}\u0000${reason.path}`, ...(reason.sourceGapId == null ? [] : [`gap:${reason.sourceGapId}`])]) {
      const existing = proofIdentities.get(key);
      if (existing !== undefined && existing !== proof) throw new Error(`Safety Score v9 reason ${reason.code} at ${reason.path} has incompatible cause proofs`);
      proofIdentities.set(key, proof);
    }
  }
  const canonical = [...reasons].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message) ||
      compareText(left.responsibility, right.responsibility),
  );
  const mergeCauseRefs = (existing: T, incoming: T): T => {
    const existingRefs = existing.causeGapIds ?? (existing.sourceGapId == null ? [] : [existing.sourceGapId]);
    const incomingRefs = incoming.causeGapIds ?? (incoming.sourceGapId == null ? [] : [incoming.sourceGapId]);
    if (incomingRefs.every((id) => existingRefs.includes(id))) return existing;
    return { ...existing, causeGapIds: uniqueSorted([...existingRefs, ...incomingRefs]) };
  };
  const byPublicIdentity = new Map<string, T>();
  const sourceGapKeys = new Map<string, string>();
  for (const reason of canonical) {
    if (options.dedupeSourceGapIds && reason.sourceGapId != null) {
      const previousKey = sourceGapKeys.get(reason.sourceGapId);
      if (previousKey !== undefined) {
        byPublicIdentity.set(previousKey, mergeCauseRefs(byPublicIdentity.get(previousKey)!, reason));
        continue;
      }
      sourceGapKeys.set(reason.sourceGapId, `${reason.code}\u0000${reason.path}`);
    }
    const key = `${reason.code}\u0000${reason.path}`;
    const existing = byPublicIdentity.get(key);
    if (existing !== undefined && existing.responsibility !== reason.responsibility) {
      throw new Error(
        `Safety Score v9 ${options.conflictSubject ?? "reason"} ${reason.code} at ${reason.path} has multiple causal owners`,
      );
    }
    byPublicIdentity.set(key, existing === undefined ? reason : mergeCauseRefs(existing, reason));
  }
  return [...byPublicIdentity.values()];
}


export function collateralExposureV9Path(exposureKey: string): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "collateral-exposure", exposureKey });
}


export function optionalExitV9Path(routeKey: string): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "optional-exit", routeKey });
}

export function createV9FactGap(args: {
  gapId: string;
  reasonCode: V9ReasonCode;
  ownerDomain: V9ReasonOwnerDomain;
  policyRuleId: string;
  observationState: Exclude<V9ObservationState, "known">;
  path: V9TypedFactPath;
  message: string;
  evidenceRefIds?: readonly string[];
}): V9FactGapV2 {
  return V9FactGapV2Schema.parse({
    ...args,
    evidenceRefIds: [...(args.evidenceRefIds ?? [])],
  });
}

export function createV9FactGapV3(args: {
  gapId: string;
  reasonCode: V9ReasonCode;
  ownerDomain: V9ReasonOwnerDomain;
  policyRuleId: string;
  observationState: Exclude<V9ObservationState, "known">;
  responsibility: V9EvidenceResponsibility;
  causeProof?: V9EvidenceCauseProof;
  causeScope?: V9EvidenceCauseScope;
  path: V9TypedFactPath;
  message: string;
  evidenceRefIds?: readonly string[];
  evidenceHistory?: {
    publishedBy: V9PublishedEvidenceAttribution;
    references: readonly V9EvidenceReferenceV2[];
  };
}): V9FactGapV3 {
  const { evidenceHistory, responsibility: _legacyLabel, ...gap } = args;
  const causeProof = args.causeProof ?? V9_UNRESEARCHED_CAUSE_PROOF;
  const evidenceRefIds = [...new Set([...(args.evidenceRefIds ?? []), ...causeProof.evidenceRefIds])].sort(compareText);
  return V9FactGapV3Schema.parse({
    ...gap,
    causeProof,
    responsibility: v9EvidenceResponsibilityForCauseProof(causeProof),
    evidenceRefIds,
    ...(evidenceHistory === undefined ? {} : {
      evidenceHistory: { publishedBy: evidenceHistory.publishedBy, evidenceRefIds: uniqueSorted(evidenceHistory.references.map((reference) => reference.evidenceId)) },
    }),
  });
}
