import { z } from "zod";
import { V9ReasonCodeSchema, type V9ReasonCode } from "./safety-score-v9";
import { V9EvidenceCauseSchema, type V9EvidenceCause, type V9ScoringDisposition } from "./safety-score-v9-causes";
import type { V9EvidenceResponsibility } from "./safety-score-v9-facts";
import type { V9PublicEvidenceFactWire } from "./safety-score-v9-public-trace";
import { V9EvidenceResponsibilitySchema } from "./safety-score-v9-fact-primitives";

/** Append-only vocabulary indexes; inline enum literals are equally valid. */
export const V9PublicFactReasonCodeSchema = z.union([V9ReasonCodeSchema, z.number().int().min(0).max(V9ReasonCodeSchema.options.length - 1)]);
export const V9PublicFactResponsibilitySchema = z.union([V9EvidenceResponsibilitySchema, z.number().int().min(0).max(V9EvidenceResponsibilitySchema.options.length - 1)]);
export const V9PublicFactCauseSchema = z.union([V9EvidenceCauseSchema, z.number().int().min(0).max(V9EvidenceCauseSchema.options.length - 1)]);
export function resolveEvidenceFactCause(value: V9EvidenceCause | number): V9EvidenceCause {
  if (typeof value === "string") return value;
  const cause = V9EvidenceCauseSchema.options[value];
  if (!Number.isInteger(value) || cause === undefined) throw new Error("Evidence cause reference is outside its vocabulary");
  return cause;
}
export function resolveEvidenceFactResponsibility(value: V9EvidenceResponsibility | number): V9EvidenceResponsibility {
  if (typeof value === "string") return value;
  const owner = V9EvidenceResponsibilitySchema.options[value];
  if (!Number.isInteger(value) || owner === undefined) throw new Error("Evidence responsibility reference is outside its vocabulary");
  return owner;
}

/** Public6/API7 fact columns; null sourceGapRef means an authored absent source. */
export const V9_PUBLIC_EVIDENCE_FACT_COLUMNS = {
  reasonCode: 0, exactFactPath: 1, sourceGapRef: 2, responsibility: 3, critical: 4, cause: 5, causeGapRefs: 6,
} as const;
const PrefixSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);
export const V9PublicEvidencePathSchema = z.union([
  z.string().min(1), z.number().int().nonnegative(), z.tuple([PrefixSchema]),
  z.tuple([PrefixSchema, z.number().int().nonnegative()]), z.tuple([z.number().int().nonnegative(), z.string().min(1)]),
]);
export type V9PublicEvidencePath = z.infer<typeof V9PublicEvidencePathSchema>;
export type V9PublicEvidenceFact = [
  reasonCode: V9ReasonCode, exactFactPath: string, sourceGapRef: number | null,
  responsibility: V9EvidenceResponsibility, critical: boolean, cause: V9EvidenceCause, causeGapRefs: number[],
];
export interface V9EvidenceFactContext { facts: readonly V9PublicEvidenceFactWire[]; factPathPrefixes?: readonly string[] }
export function resolveEvidenceFactPath(evidence: Pick<V9EvidenceFactContext, "factPathPrefixes">, row: V9PublicEvidenceFactWire): string {
  const path = row[1];
  if (typeof path === "string") return path;
  const prefix = typeof path === "number" ? path : path[0];
  if (typeof prefix === "number" && (!Number.isInteger(prefix) || prefix < 0)) {
    throw new Error("Fact path prefix reference is outside its table");
  }
  const value = typeof prefix === "string" ? prefix : evidence.factPathPrefixes?.[prefix];
  if (value === undefined) throw new Error("Fact path prefix reference is outside its table");
  if (typeof path === "number") return value;
  if (typeof path[1] === "string") return value + path[1];
  const ref = path[1] ?? row[2] ?? (typeof row[6] === "number" ? row[6] : row[6][0]);
  if (ref === undefined) throw new Error("Causal fact path has no reference");
  return `${value}:cause:${ref}`;
}
export function* iterateEvidenceResponsibilityFacts(evidence: V9EvidenceFactContext): IterableIterator<V9PublicEvidenceFact> {
  for (const row of evidence.facts) {
    const code = typeof row[0] === "string" ? row[0] : V9ReasonCodeSchema.options[row[0]];
    if (code === undefined) throw new Error("Evidence reason reference is outside its vocabulary");
    yield [code, resolveEvidenceFactPath(evidence, row), row[2], resolveEvidenceFactResponsibility(row[3]), Boolean(row[4]), resolveEvidenceFactCause(row[5]), typeof row[6] === "number" ? [row[6]] : row[6]];
  }
}

/**
 * Count source obligations without dropping their scoring witnesses. A source-less
 * singleton causal view is an alias only when that exact source is present on
 * this card under the same owner. Foreign-root and gapless views remain separate.
 */
export function countV9EvidenceObligations<T, Ref extends string | number>(
  facts: readonly T[],
  sourceFor: (fact: T) => Ref | null,
  causesFor: (fact: T) => readonly Ref[],
  criticalFor: (fact: T) => boolean,
): { factCount: number; criticalFactCount: number } {
  const sources = new Map<Ref, boolean>();
  let factCount = 0;
  let criticalFactCount = 0;
  for (const fact of facts) {
    const source = sourceFor(fact);
    if (source === null) continue;
    sources.set(source, (sources.get(source) ?? false) || criticalFor(fact));
  }
  for (const fact of facts) {
    if (sourceFor(fact) !== null) continue;
    const causes = causesFor(fact);
    const root = causes.length === 1 ? causes[0]! : undefined;
    if (root !== undefined && sources.has(root)) {
      if (criticalFor(fact)) sources.set(root, true);
    } else {
      factCount++;
      if (criticalFor(fact)) criticalFactCount++;
    }
  }
  factCount += sources.size;
  for (const critical of sources.values()) if (critical) criticalFactCount++;
  return { factCount, criticalFactCount };
}
export function refineEvidenceFactPathPrefixes(evidence: V9EvidenceFactContext, ctx: Pick<z.RefinementCtx, "addIssue">): boolean {
  const used = new Uint8Array(evidence.factPathPrefixes?.length ?? 0);
  let valid = true;
  for (let index = 0; index < evidence.facts.length; index++) {
    const path = evidence.facts[index]![1];
    const ref = typeof path === "number" ? path : Array.isArray(path) && typeof path[0] === "number" ? path[0] : undefined;
    if (ref === undefined) continue;
    if (!Number.isInteger(ref) || ref < 0 || ref >= used.length) {
      valid = false;
      ctx.addIssue({ code: "custom", path: ["facts", index, 1], message: "Fact path prefix reference is outside its table" });
    } else used[ref] = 1;
  }
  if (used.some((value) => value === 0)) {
    valid = false;
    ctx.addIssue({ code: "custom", path: ["factPathPrefixes"], message: "Every fact path prefix must be referenced" });
  }
  return valid;
}
export function publicCauseScoringDisposition(cause: V9EvidenceCause): V9ScoringDisposition {
  return cause === "A" ? "excluded-pipeline" : cause === "B" ? "excluded-uncurated"
    : cause === "D" ? "measured-adverse" : "bounded-uncertainty";
}
