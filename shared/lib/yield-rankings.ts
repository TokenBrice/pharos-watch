import type { YieldRanking } from "../types";

function score(value: number | null | undefined) {
  return value ?? Number.NEGATIVE_INFINITY;
}

function isPreferredRanking(candidate: YieldRanking, current: YieldRanking) {
  if (score(candidate.currentApy) !== score(current.currentApy)) {
    return score(candidate.currentApy) > score(current.currentApy);
  }

  if (score(candidate.pharosYieldScore) !== score(current.pharosYieldScore)) {
    return score(candidate.pharosYieldScore) > score(current.pharosYieldScore);
  }

  if (score(candidate.apy30d) !== score(current.apy30d)) {
    return score(candidate.apy30d) > score(current.apy30d);
  }

  if (score(candidate.sourceTvlUsd) !== score(current.sourceTvlUsd)) {
    return score(candidate.sourceTvlUsd) > score(current.sourceTvlUsd);
  }

  return false;
}

export function dedupeYieldRankings(rankings: YieldRanking[]): YieldRanking[] {
  const deduped = new Map<string, YieldRanking>();

  for (const ranking of rankings) {
    const current = deduped.get(ranking.id);
    if (!current || isPreferredRanking(ranking, current)) {
      deduped.set(ranking.id, ranking);
    }
  }

  return [...deduped.values()];
}
