export interface V9PublicCauseGapTable {
  id: string;
  localCauseGaps: readonly string[];
  foreignCauseGapRefs: readonly number[];
}
export interface V9PublicCauseGapContext { foreignCauseGaps: readonly string[] }

/** The sole gap-ID resolver; refs address local gaps then card-selected root gaps. */
export function resolveCauseGapId(response: V9PublicCauseGapContext, card: V9PublicCauseGapTable, ref: number): string {
  if (!Number.isInteger(ref) || ref < 0) throw new Error("Cause gap reference is outside the card gap table");
  if (ref < card.localCauseGaps.length) return `${card.id}:gap:${card.localCauseGaps[ref]!}`;
  const globalRef = card.foreignCauseGapRefs[ref - card.localCauseGaps.length];
  if (globalRef === undefined || !Number.isInteger(globalRef) || globalRef < 0 || globalRef >= response.foreignCauseGaps.length) {
    throw new Error("Cause gap reference is outside the publication gap table");
  }
  return response.foreignCauseGaps[globalRef]!;
}
