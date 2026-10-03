import { z } from "zod";
import type { V9ReasonCode } from "./safety-score-v9";
import type { V9EvidenceCause, V9ScoringDisposition } from "./safety-score-v9-causes";
import type { V9EvidenceResponsibility } from "./safety-score-v9-facts";

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
export type V9PublicEvidenceFactWire = [
  reasonCode: V9ReasonCode, exactFactPath: V9PublicEvidencePath, sourceGapRef: number | null,
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
  const ref = path[1] ?? row[2] ?? row[6][0];
  if (ref === undefined) throw new Error("Causal fact path has no reference");
  return `${value}:cause:${ref}`;
}
export function* iterateEvidenceResponsibilityFacts(evidence: V9EvidenceFactContext): IterableIterator<V9PublicEvidenceFact> {
  for (const row of evidence.facts) {
    if (typeof row[1] === "string") { yield row as V9PublicEvidenceFact; continue; }
    yield [row[0], resolveEvidenceFactPath(evidence, row), row[2], row[3], row[4], row[5], row[6]];
  }
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
