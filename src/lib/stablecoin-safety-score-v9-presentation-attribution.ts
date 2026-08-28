import type { SafetyScoreV9CurrentCard } from "@shared/types";
import {
  SAFETY_SCORE_V9_RESPONSIBILITY_LABELS,
  SAFETY_SCORE_V9_RESPONSIBILITY_ORDER,
} from "@/lib/safety-score-v9-labels";
import {
  humanizeSafetyScoreV9Value,
  uniqueSafetyScoreV9Messages,
} from "@/lib/stablecoin-safety-score-v9-presentation-helpers";

export interface StablecoinSafetyScoreV9AttributionGroup {
  key: string;
  label: string;
  messages: string[];
}

function attributionGroups(
  items: ReadonlyArray<{ message: string; responsibility: string }>,
): StablecoinSafetyScoreV9AttributionGroup[] {
  const byResponsibility = new Map<string, string[]>();
  for (const item of items) {
    const existing = byResponsibility.get(item.responsibility);
    if (existing) existing.push(item.message);
    else byResponsibility.set(item.responsibility, [item.message]);
  }
  return [...byResponsibility.entries()]
    .sort(([left], [right]) => {
      const leftRank = SAFETY_SCORE_V9_RESPONSIBILITY_ORDER.indexOf(left);
      const rightRank = SAFETY_SCORE_V9_RESPONSIBILITY_ORDER.indexOf(right);
      return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank)
        - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
    })
    .map(([responsibility, messages]) => ({
      key: responsibility,
      label: SAFETY_SCORE_V9_RESPONSIBILITY_LABELS[responsibility]
        ?? humanizeSafetyScoreV9Value(responsibility),
      messages: uniqueSafetyScoreV9Messages(messages),
    }));
}

export interface StablecoinSafetyScoreV9Attribution {
  adverseMessages: string[];
  boundedGroups: StablecoinSafetyScoreV9AttributionGroup[];
}

export function buildSafetyScoreV9Attribution(
  card: SafetyScoreV9CurrentCard,
): StablecoinSafetyScoreV9Attribution {
  return {
    adverseMessages: uniqueSafetyScoreV9Messages(card.scoreTrace.adverseAttribution.items.map((item) => item.message)),
    boundedGroups: attributionGroups(card.scoreTrace.boundedUncertaintyAttribution.items),
  };
}
