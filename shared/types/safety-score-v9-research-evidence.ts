import { z } from "zod";
import { canonicalArrayBy } from "./safety-score-v9-fact-primitives";
import { CanonicalTextSchema, Sha256Schema, UnixSecondsSchema } from "./safety-score-v9-fact-input-primitives";

export const ResearchEvidenceSchema = z
  .object({
    evidenceKey: CanonicalTextSchema,
    sourceId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    publishedAtSec: UnixSecondsSchema.nullable(),
    publishedBy: z.enum(["issuer", "parent", "other", "unknown"]).optional(),
    url: z.string().url().nullable(),
    contentSha256: Sha256Schema,
    confidence: z.enum(["verified", "probable", "manual-review", "limited", "unknown"]),
    maxAgeSec: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.publishedAtSec !== null && evidence.publishedAtSec < evidence.observedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedAtSec"],
        message: "Research evidence publication cannot predate observation",
      });
    }
  });

export const ComponentEvidenceBindingSchema = z
  .object({
    componentKey: CanonicalTextSchema,
    evidenceKeys: canonicalArrayBy(CanonicalTextSchema, (value) => value).refine((values) => values.length > 0, {
      message: "Component evidence binding requires at least one evidence key",
    }),
  })
  .strict();

export type ResearchEvidence = z.output<typeof ResearchEvidenceSchema>;
export type ComponentEvidence = z.output<typeof ComponentEvidenceBindingSchema>;
