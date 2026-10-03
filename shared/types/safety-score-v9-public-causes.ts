import type { V9PublicCauseGapTable, V9PublicCauseGapContext } from "./safety-score-v9-public-cause-gaps";
import { z } from "zod";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
import { V9_PUBLIC_EVIDENCE_FACT_COLUMNS as FACT, resolveEvidenceFactPath, type V9PublicEvidenceFactWire, type V9EvidenceFactContext } from "./safety-score-v9-public-evidence-facts";
import {
  V9EvidenceCauseSchema, V9ScoringDispositionSchema, V9RatingStatusSchema,
  V9PillarAggregationDispositionSchema, V9CompactPartialEvidenceSchema,
  refineV9CauseContribution, refineV9RatingStatusFields, resolveV9EffectiveScoringWeight,
} from "./safety-score-v9-causes";
export { V9EvidenceCauseSchema, V9ScoringDispositionSchema, V9RatingStatusSchema, refineV9RatingStatusFields };

export function causeGapRefs(minimum = 0) {
  return z.array(z.number().int().nonnegative()).min(minimum).superRefine((refs, ctx) => {
    if (refs.some((ref, index) => index > 0 && ref <= refs[index - 1]!)) {
      ctx.addIssue({ code: "custom", message: "Cause gap references must be unique and increasing" });
    }
  });
}
export const V9CauseContributionShape = {
  cause: V9EvidenceCauseSchema.nullable().optional(), causeGapRefs: causeGapRefs().optional(),
  scoringDisposition: V9ScoringDispositionSchema.optional(), effectiveScoringWeight: z.number().finite().min(0).max(1).optional().describe("Defaults to zero for excluded/not-applicable contributions, otherwise one"),
};
export { refineV9CauseContribution, resolveV9EffectiveScoringWeight };
const ConfidenceFactorSchema = z.object({
  factor: z.number().finite().min(0).max(1), cause: V9EvidenceCauseSchema.nullable().optional(),
  causeGapRefs: causeGapRefs().optional(),
}).strict().superRefine((value, ctx) => {
  if (((value.cause === "A" || value.cause === "B") && value.factor !== 1) ||
      (value.cause != null && (value.causeGapRefs?.length ?? 0) === 0)) {
    ctx.addIssue({ code: "custom", message: "A/B confidence is neutral; causal dimensions require gap references" });
  }
});
export const V9ConfidenceDimensionsSchema = z.object({
  observation: ConfidenceFactorSchema, model: ConfidenceFactorSchema, capacityMethod: ConfidenceFactorSchema,
}).strict();
export const V9PartialEvidenceSchema = z.object({
  reasonCode: z.literal("partial-evidence-pipeline-gap"),
  excludedPillars: canonicalTextArray().pipe(z.array(z.enum(["backing", "exit", "control"]))),
  excludedComponentKeys: canonicalTextArray(), causeGapRefs: causeGapRefs(1),
  causes: canonicalTextArray(1).pipe(z.array(V9EvidenceCauseSchema.extract(["A", "B"]))),
}).strict();
export const V9PillarCauseShape = {
  aggregationDisposition: V9PillarAggregationDispositionSchema.optional().describe("Defaults to included"), supportedComponentKeys: canonicalTextArray(),
  causeGapRefs: causeGapRefs().optional(),
  limitedEvidenceCauses: canonicalTextArray().pipe(z.array(V9EvidenceCauseSchema.extract(["C", "U", "D"]))).optional().describe("Defaults to no limiting causes"),
};
export const V9BreakdownCauseShape = {
  aggregationDisposition: V9PillarCauseShape.aggregationDisposition, causeGapRefs: causeGapRefs().optional(),
  limitedEvidenceCauses: V9PillarCauseShape.limitedEvidenceCauses,
};
export const V9DependencyCauseShape = {
  ratingStatus: V9RatingStatusSchema, partialEvidence: V9CompactPartialEvidenceSchema.nullable(),
  causeGapRefs: causeGapRefs().optional(),
  limitedEvidenceCauses: V9PillarCauseShape.limitedEvidenceCauses,
};

/** The compact wire never expands IDs or silently repairs invalid references. */
export function refineV9PublicGapReferences(card: V9PublicCauseGapTable, ctx: Pick<z.RefinementCtx, "addIssue">): void {
  const referenced = new Uint8Array(card.localCauseGaps.length + card.foreignCauseGapRefs.length);
  const mark = (ref: unknown): void => {
    if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 0 || ref >= referenced.length) {
      ctx.addIssue({ code: "custom", message: "Cause gap reference is outside the card gap table" });
    } else referenced[ref] = 1;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node === null || typeof node !== "object") return;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key) || key === "localCauseGaps" || key === "foreignCauseGapRefs") continue;
      const value = (node as Record<string, unknown>)[key];
      if (key === "facts" && Array.isArray(value)) {
        for (const row of value) {
          if (!Array.isArray(row)) continue;
          if (row[FACT.sourceGapRef] !== null) mark(row[FACT.sourceGapRef]);
          for (const ref of row[FACT.causeGapRefs]) mark(ref);
          let path: string;
          try { path = resolveEvidenceFactPath(node as Pick<V9EvidenceFactContext, "factPathPrefixes">, row as V9PublicEvidenceFactWire); }
          catch { ctx.addIssue({ code: "custom", message: "Fact paths must resolve through their declared prefix table" }); continue; }
          const suffix = /:cause:(\d+)$/u.exec(path);
          if (suffix) mark(Number(suffix[1]));
          else if (path.includes(":cause:")) ctx.addIssue({ code: "custom", message: "Causal fact paths must use a numeric reference" });
        }
        continue;
      }
      if (key === "causeGapRefs" && Array.isArray(value)) { for (const ref of value) mark(ref); }
      else if (key === "sourceGapRef" && value !== null) mark(value);
      else if ((key === "path" || key === "exactFactPath" || key === "field") && typeof value === "string" && value.includes(":cause:")) {
        const match = /:cause:(\d+)$/u.exec(value);
        if (!match) ctx.addIssue({ code: "custom", message: "Causal paths must use a numeric gap reference" });
        else mark(Number(match[1]));
      } else if (key === "causeGapIds" || key === "sourceGapId") {
        ctx.addIssue({ code: "custom", message: "Public causes use references, never repeated gap IDs" });
      } else visit(value);
    }
  };
  visit(card);
  if (referenced.some((used) => used === 0)) ctx.addIssue({ code: "custom", message: "Every card gap table entry must be referenced" });
}

export function refineV9PublicGapContext(response: V9PublicCauseGapContext & { cards: readonly V9PublicCauseGapTable[] }, ctx: Pick<z.RefinementCtx, "addIssue">): void {
  const used = new Uint8Array(response.foreignCauseGaps.length);
  for (const card of response.cards) {
    const prefix = `${card.id}:gap:`;
    for (const ref of card.foreignCauseGapRefs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= used.length) ctx.addIssue({ code: "custom", message: "Foreign gap reference is outside the publication table" });
      else {
        used[ref] = 1;
        if (response.foreignCauseGaps[ref]!.startsWith(prefix)) ctx.addIssue({ code: "custom", message: "Owning-card gaps must use the local table" });
      }
    }
  }
  if (used.some((value) => value === 0)) ctx.addIssue({ code: "custom", path: ["foreignCauseGaps"], message: "Every publication gap table entry must be referenced" });
}
