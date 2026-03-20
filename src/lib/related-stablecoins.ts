import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { StablecoinMeta } from "@shared/types";

function scoreRelatedStablecoin(candidate: StablecoinMeta, current: StablecoinMeta): number {
  let score = 0;
  if (candidate.flags.governance === current.flags.governance) score += 3;
  if (candidate.flags.backing === current.flags.backing) score += 2;
  if (candidate.flags.pegCurrency === current.flags.pegCurrency) score += 1;
  return score;
}

export function getRelatedStablecoins(
  current: StablecoinMeta,
  options: {
    limit?: number;
    candidates?: readonly StablecoinMeta[];
  } = {},
): StablecoinMeta[] {
  const { limit = 6, candidates = ACTIVE_STABLECOINS } = options;

  return candidates
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => ({
      coin: candidate,
      score: scoreRelatedStablecoin(candidate, current),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.coin);
}
