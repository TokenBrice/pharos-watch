import type { z } from "zod";
import type { SafetyScoreV9CurrentCardBaseSchema } from "./safety-score-v9-public";

type SafetyScoreV9CurrentCardInput = z.input<typeof SafetyScoreV9CurrentCardBaseSchema>;

export type SafetyScoreV9CardRefinementInput = Pick<
  SafetyScoreV9CurrentCardInput,
  "score" | "grade" | "qualityScore" | "pegMultiplier" | "pegAdjustedScore" | "pillars" |
  "weakestPillar" | "caps" | "bindingCap" | "dependencies" | "scoreTrace"
>;
export type SafetyScoreV9SerialDependencyInput = SafetyScoreV9CardRefinementInput["dependencies"]["serial"][number];
export type SafetyScoreV9CardWithDependencies = Pick<SafetyScoreV9CardRefinementInput, "dependencies">;
