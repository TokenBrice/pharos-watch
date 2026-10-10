import type { SafetyScoreV9CurrentCard } from "../../types/safety-score-v9-public";
import type { V9PublicEvidenceFact, V9PublicEvidencePath } from "../../types/safety-score-v9-public-evidence-facts";
import type { V9PublicEvidenceFactWire } from "../../types/safety-score-v9-public-trace";
import { publicCauseScoringDisposition } from "../../types/safety-score-v9-public-evidence-facts";
import type { V9EvidenceCause, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import { internEvidenceFactPathPrefixes } from "./public-evidence-path-interning";
interface UninternedEvidenceFact {
  reasonCode: V9PublicEvidenceFact[0]; exactFactPath: string; sourceGapId: string | null;
  responsibility: V9PublicEvidenceFact[3]; critical: boolean; cause: V9EvidenceCause;
  causeGapIds: string[]; scoringDisposition: V9ScoringDisposition;
}
const EMPTY_REFS: number[] = [];

/** Private projection input, before the sole public wire is interned. */
export type V9UninternedPublic<T> = T extends readonly (infer U)[] ? V9UninternedPublic<U>[]
  : T extends object ? { [K in keyof T as K extends "localCauseGaps" | "foreignCauseGapRefs" ? never : K extends "causeGapRefs" ? "causeGapIds" : K extends "sourceGapRef" ? "sourceGapId" : K]:
    K extends "causeGapRefs" ? string[] : K extends "sourceGapRef" ? string | null :
    K extends "facts" ? T[K] extends V9PublicEvidenceFactWire[] ? UninternedEvidenceFact[] : V9UninternedPublic<T[K]> : V9UninternedPublic<T[K]> }
    : T;
export type V9UninternedPublicCard = V9UninternedPublic<SafetyScoreV9CurrentCard>;
export type V9InternedPublicCardDraft = Omit<SafetyScoreV9CurrentCard, "foreignCauseGapRefs"> & { foreignCauseGaps: string[] };
const isPath = (key: string) => key === "path" || key === "exactFactPath" || key === "field";
function causalSuffix(path: string): { prefix: string; id: string } | null {
  const index = path.lastIndexOf(":cause:");
  if (index < 0 || index + 7 === path.length) return null;
  const suffix = path.slice(index + 7);
  let id = suffix;
  // Full literal IDs retain colons; encoded IDs have none. Do not decode a
  // literal percent escape as part of the source identity.
  if (!suffix.includes(":")) {
    try { id = decodeURIComponent(suffix); } catch { /* Keep a stray percent sign literal. */ }
  }
  return { prefix: path.slice(0, index), id };
}

/** Copy-on-write: shared evaluator objects are never mutated or fully cloned. */
export function internV9PublicCauseGaps(card: V9UninternedPublicCard): V9InternedPublicCardDraft {
  const ids = new Set<string>();
  function collect(node: unknown): void {
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (node === null || typeof node !== "object") return;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const value = (node as Record<string, unknown>)[key];
      if (key === "causeGapIds" && Array.isArray(value)) for (const id of value) ids.add(id as string);
      else if (key === "sourceGapId" && typeof value === "string") ids.add(value);
      else if (isPath(key) && typeof value === "string") {
        const suffix = causalSuffix(value);
        if (suffix) ids.add(suffix.id);
      } else collect(value);
    }
  }
  collect(card);
  const prefix = `${card.id}:gap:`;
  const localCauseGaps: string[] = [], foreignCauseGaps: string[] = [];
  for (const id of ids) (id.startsWith(prefix) ? localCauseGaps : foreignCauseGaps).push(id);
  localCauseGaps.sort(); foreignCauseGaps.sort();
  const refs = new Map<string, number>();
  for (let ref = 0; ref < localCauseGaps.length; ref++) {
    const id = localCauseGaps[ref]!;
    refs.set(id, ref); localCauseGaps[ref] = id.slice(prefix.length);
  }
  for (let ref = 0; ref < foreignCauseGaps.length; ref++) refs.set(foreignCauseGaps[ref]!, localCauseGaps.length + ref);
  const reference = (id: string): number => {
    const ref = refs.get(id);
    if (ref === undefined) throw new Error(`Uninterned cause gap ${id}`);
    return ref;
  };
  function compact(node: unknown): unknown {
    if (Array.isArray(node)) {
      let result: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        const child = compact(node[i]);
        if (child !== node[i]) { result ??= node.slice(); result[i] = child; }
      }
      return result ?? node;
    }
    if (node === null || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (key === "facts" && Array.isArray(value)) {
        result ??= { ...source };
        result[key] = value.map((raw: UninternedEvidenceFact) => {
          if (raw.scoringDisposition !== publicCauseScoringDisposition(raw.cause)) {
            throw new Error("Evidence fact disposition must agree with its causal authority");
          }
          const fact = compact(raw) as Record<string, unknown>;
          const path = fact.exactFactPath as string, sourceGapRef = fact.sourceGapRef as number | null;
          const gapRefs = (fact.causeGapRefs ?? EMPTY_REFS) as number[];
          const suffix = causalSuffix(path);
          let encodedPath: V9PublicEvidencePath = path;
          if (suffix && suffix.prefix.length > 0) {
            const ref = Number(suffix.id), prefix = suffix.prefix;
            encodedPath = ref === (sourceGapRef ?? gapRefs[0]) ? [prefix] : [prefix, ref];
          }
          return [fact.reasonCode, encodedPath, sourceGapRef, fact.responsibility, fact.critical, fact.cause, gapRefs];
        });
        continue;
      }
      if (key === "causeGapIds" && Array.isArray(value)) {
        result ??= { ...source }; delete result[key];
        if (value.length > 0) result.causeGapRefs = value.map((id) => reference(id as string)).sort(compareRefs);
      } else if (key === "sourceGapId") {
        result ??= { ...source }; delete result[key];
        result.sourceGapRef = value === null ? null : reference(value as string);
      } else if ((key === "cause" && value === null) || (key === "scoringDisposition" && value === "included") ||
          (key === "aggregationDisposition" && value === "included") ||
          (key === "limitedEvidenceCauses" && Array.isArray(value) && value.length === 0) ||
          (key === "normalizedWeight" && value === 0) ||
          (key === "wholeAssetWeight" && typeof value === "number" && value === source.effectiveScoringWeight) ||
          (key === "effectiveScoringWeight" && value ===
            (source.scoringDisposition === "excluded-pipeline" || source.scoringDisposition === "excluded-uncurated" || source.scoringDisposition === "not-applicable" ? 0 : 1)) ||
          (typeof source.responsibility === "string" && Array.isArray(source.reasonCodes) &&
            (((key === "factCount" || key === "criticalFactCount") && value === 0) || (key === "reasonCodes" && Array.isArray(value) && value.length === 0)))) {
        result ??= { ...source }; delete result[key];
      } else if (isPath(key) && typeof value === "string") {
        const suffix = causalSuffix(value);
        if (suffix) {
          result ??= { ...source };
          result[key] = suffix.prefix + `:cause:${reference(suffix.id)}`;
        }
      } else {
        const child = compact(value);
        if (child !== value) { result ??= { ...source }; result[key] = child; }
      }
    }
    return result ?? node;
  }
  const result = { ...(compact(card) as Record<string, unknown>), localCauseGaps, foreignCauseGaps } as V9InternedPublicCardDraft;
  const prefixes = internEvidenceFactPathPrefixes(result.scoreTrace.evidenceResponsibility.facts);
  if (prefixes !== undefined) result.scoreTrace.evidenceResponsibility.factPathPrefixes = prefixes;
  result.scoreTrace.boundedUncertaintyAttribution.items.sort((a, b) =>
    compare(a.source, b.source) || compare(a.code, b.code) || compare(a.path, b.path) ||
    compare(a.message, b.message) || compare(a.responsibility, b.responsibility));
  return result;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareRefs(a: number, b: number): number { return a - b; }

export function finalizeV9PublicCauseGaps(drafts: readonly V9InternedPublicCardDraft[]): { cards: SafetyScoreV9CurrentCard[]; foreignCauseGaps: string[] } {
  const ids = new Set<string>();
  for (const card of drafts) for (const id of card.foreignCauseGaps) ids.add(id);
  const foreignCauseGaps = [...ids].sort();
  const refs = new Map<string, number>();
  for (let ref = 0; ref < foreignCauseGaps.length; ref++) refs.set(foreignCauseGaps[ref]!, ref);
  const cards = drafts.map(({ foreignCauseGaps: foreign, ...card }) => ({
    ...card, foreignCauseGapRefs: foreign.map((id) => {
      const ref = refs.get(id);
      if (ref === undefined) throw new Error("Foreign cause gap was not interned at publication scope");
      return ref;
    }),
  }));
  return { cards, foreignCauseGaps };
}
