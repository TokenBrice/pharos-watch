import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import { Sha256Schema } from "./safety-schema-primitives";
import { SafetyGradesResponseSchema } from "./report-cards-v9";

/** Publish-time projection only: no independent scoring or freshness authority. */
export const SafetyScoreIndexSchema = z.object({
  schemaVersion: z.literal(1),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  publicationResultDigest: Sha256Schema,
  asOfSec: z.number().int().nonnegative(),
  publishedAtSec: z.number().int().nonnegative(),
  expectedCount: z.number().int().nonnegative(),
  scores: z.record(z.string().min(1), SafetyGradesResponseSchema.shape.grades.element.omit({ id: true })),
}).strict().superRefine((index, ctx) => {
  if (Object.keys(index.scores).length !== index.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["scores"], message: "Score index must cover the accepted card set" });
  }
  if (index.publishedAtSec < index.asOfSec) {
    ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Publication cannot predate evidence" });
  }
  for (const [id, entry] of Object.entries(index.scores)) {
    if ((entry.score === null) !== (entry.grade === "NR")) {
      ctx.addIssue({ code: "custom", path: ["scores", id], message: "Unavailable scores must retain NR" });
    }
  }
});
