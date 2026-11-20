import type { YieldRanking } from "../types/yield";
import { compareCodeUnits } from "./compare";
import { numberValue } from "./type-guards";

type YieldRankFields = Pick<YieldRanking, "pharosYieldScore" | "currentApy" | "name">;

/** Served ranking order: PYS desc (null last), current APY desc, then name. */
export function compareYieldRankRows(a: YieldRankFields, b: YieldRankFields): number {
  const aScore = numberValue(a.pharosYieldScore);
  const bScore = numberValue(b.pharosYieldScore);
  if (aScore != null || bScore != null) {
    if (aScore == null) return 1;
    if (bScore == null) return -1;
    if (aScore !== bScore) return bScore - aScore;
  }
  const apyDiff = b.currentApy - a.currentApy;
  if (apyDiff !== 0) return apyDiff;
  return compareCodeUnits(a.name, b.name);
}
