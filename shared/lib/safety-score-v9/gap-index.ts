import type { V9EvidenceResponsibility, V9FactGapV2, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import type { V9ReasonCode } from "../../types/safety-score-v9";
import { canonicalUniqueBy, compareText, uniqueSorted } from "./primitives";

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
  readonly responsibility?: V9EvidenceResponsibility;
}

export function projectGapReasons<Treatment, G extends V9Gap>({
  index,
  gapIds,
  path,
  pathFor,
  fallbackCode,
  fallbackMessage,
  treatmentFor,
  fallbackResponsibility,
}: {
  index: V9GapIndex<G>;
  gapIds: readonly string[];
  path: string;
  pathFor?: (gap: G) => string;
  fallbackCode: V9ReasonCode;
  fallbackMessage?: string;
  treatmentFor: (code: V9ReasonCode) => Treatment;
  fallbackResponsibility?: V9EvidenceResponsibility;
}): V9GapReasonProjection<Treatment>[] {
  const projected = gapsForV9Ids(index, gapIds).map((gap) => ({
    code: gap.reasonCode,
    path: pathFor?.(gap) ?? path,
    message: gap.message,
    gapIds: [gap.gapId],
    treatment: treatmentFor(gap.reasonCode),
    ...("responsibility" in gap ? { responsibility: gap.responsibility } : {}),
  }));
  if (projected.length > 0) return projected;
  return [{
    code: fallbackCode,
    path,
    gapIds: uniqueSorted(gapIds),
    ...(fallbackMessage === undefined ? {} : { message: fallbackMessage }),
    treatment: treatmentFor(fallbackCode),
    ...(fallbackResponsibility === undefined
      ? {}
      : { responsibility: fallbackResponsibility }),
  }];
}
