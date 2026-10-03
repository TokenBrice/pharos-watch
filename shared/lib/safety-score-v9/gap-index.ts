import type { V9EvidenceResponsibility, V9FactGapV2, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import type { V9ReasonCode } from "../../types/safety-score-v9";
import { canonicalUniqueBy, compareText, uniqueSorted } from "./primitives";
import type { V9EvidenceCause } from "../../types/safety-score-v9-causes";
import { stableJsonStringifyV1 } from "../stable-json";
import { v9EvidenceResponsibilityForCauseProof } from "../../types/safety-score-v9-causes";

export type V9Gap = V9FactGapV2 | V9FactGapV3;

export interface V9GapIndex<G extends V9Gap = V9Gap> {
  readonly byId: ReadonlyMap<string, G>;
  readonly byDomainAndCode: ReadonlyMap<string, readonly G[]>;
}

export function gapDomainAndCodeKey(ownerDomain: V9Gap["ownerDomain"], reasonCode: V9ReasonCode): string {
  return `${ownerDomain}\u0000${reasonCode}`;
}

export function gapsForV9Ids<G extends V9Gap>(index: V9GapIndex<G>, gapIds: readonly string[]): G[] {
  return gapIds.flatMap((gapId) => {
    const gap = index.byId.get(gapId);
    return gap === undefined ? [] : [gap];
  });
}

export function createV9GapIndex<G extends V9Gap>(gaps: readonly G[]): V9GapIndex<G> {
  const proofsById = new Map<string, string>();
  for (const gap of gaps) {
    const proof = stableJsonStringifyV1("causeProof" in gap ? { proof: gap.causeProof, scope: gap.causeScope ?? null } : null);
    const existing = proofsById.get(gap.gapId);
    if (existing !== undefined && existing !== proof) throw new Error(`Incompatible cause proofs for gap ${gap.gapId}`);
    proofsById.set(gap.gapId, proof);
  }
  const canonicalGaps = canonicalUniqueBy(
    gaps,
    (gap) => gap.gapId,
    (left, right) => compareText(left.gapId, right.gapId),
    "first",
  );
  const byId = new Map(canonicalGaps.map((gap) => [gap.gapId, gap] as const));
  const byDomainAndCode = new Map<string, G[]>();
  for (const gap of canonicalGaps) {
    const key = gapDomainAndCodeKey(gap.ownerDomain, gap.reasonCode);
    byDomainAndCode.set(key, [...(byDomainAndCode.get(key) ?? []), gap]);
  }
  return { byId, byDomainAndCode };
}

export interface V9GapReasonProjection<Treatment> {
  readonly code: V9ReasonCode;
  readonly path: string;
  readonly message?: string;
  readonly gapIds: readonly string[];
  readonly treatment: Treatment;
  readonly responsibility: V9EvidenceResponsibility;
  readonly cause: V9EvidenceCause;
  readonly causeGapIds: readonly string[];
}

export function projectGapReasons<Treatment, G extends V9Gap>({
  index,
  gapIds,
  path,
  pathFor,
  fallbackCode,
  fallbackMessage,
  treatmentFor,
}: {
  index: V9GapIndex<G>;
  gapIds: readonly string[];
  path: string;
  pathFor?: (gap: G) => string;
  fallbackCode: V9ReasonCode;
  fallbackMessage?: string;
  treatmentFor: (code: V9ReasonCode, cause: V9EvidenceCause) => Treatment;
}): V9GapReasonProjection<Treatment>[] {
  const projected = gapsForV9Ids(index, gapIds).map((gap) => ({
    code: gap.reasonCode,
    path: pathFor?.(gap) ?? path,
    message: gap.message,
    gapIds: [gap.gapId],
    treatment: treatmentFor(gap.reasonCode, "causeProof" in gap ? gap.causeProof.cause : "U"),
    cause: "causeProof" in gap ? gap.causeProof.cause : "U",
    causeGapIds: [gap.gapId],
    responsibility: "causeProof" in gap ? v9EvidenceResponsibilityForCauseProof(gap.causeProof) : "unresearched",
  }));
  if (projected.length > 0) return projected;
  return [{
    code: fallbackCode,
    path,
    gapIds: uniqueSorted(gapIds),
    ...(fallbackMessage === undefined ? {} : { message: fallbackMessage }),
    treatment: treatmentFor(fallbackCode, "U"),
    cause: "U",
    causeGapIds: uniqueSorted(gapIds),
    responsibility: "unresearched",
  }];
}
