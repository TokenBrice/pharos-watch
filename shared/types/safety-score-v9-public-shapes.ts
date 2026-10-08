import type { z } from "zod";
import type { SafetyScoreV9CurrentCardBaseSchema } from "./safety-score-v9-public";

type SafetyScoreV9ParsedCurrentCard = z.output<typeof SafetyScoreV9CurrentCardBaseSchema>;

export type SafetyScoreV9CardRefinementInput = Pick<
  SafetyScoreV9ParsedCurrentCard,
  "score" | "grade" | "qualityScore" | "pegMultiplier" | "pegAdjustedScore" | "pillars" |
  "weakestPillar" | "caps" | "bindingCap" | "dependencies" | "scoreTrace" | "ratingStatus" | "partialEvidence"
> & { breakdowns: Pick<NonNullable<SafetyScoreV9ParsedCurrentCard["breakdowns"]>, "backing"> | null };
export type SafetyScoreV9SerialDependencyInput = SafetyScoreV9CardRefinementInput["dependencies"]["serial"][number];
export type SafetyScoreV9CardWithDependencies = Pick<SafetyScoreV9CardRefinementInput, "dependencies">;
