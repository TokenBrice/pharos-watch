import type { SafetyScoreV9CurrentCard } from "@shared/types";
import {
  humanizeSafetyScoreV9Value,
  isUnknownSafetyScoreV9Value,
} from "@/lib/stablecoin-safety-score-v9-presentation-helpers";

const ACCESS_FIELDS = [
  ["transfer", "Transfer"],
  ["freezeExposure", "Freeze exposure"],
  ["primaryExit", "Primary exit"],
  ["governance", "Governance"],
] as const;

export interface StablecoinSafetyScoreV9AccessRow {
  key: string;
  label: string;
  value: string;
}

/** Access posture rows for the summary rail; unknown fields drop out. */
export function buildSafetyScoreV9AccessRows(
  card: SafetyScoreV9CurrentCard,
): StablecoinSafetyScoreV9AccessRow[] {
  return ACCESS_FIELDS.flatMap(([key, label]) => {
    const value = card.accessPosture[key];
    return isUnknownSafetyScoreV9Value(value) ? [] : [{ key, label, value: humanizeSafetyScoreV9Value(value) }];
  });
}
