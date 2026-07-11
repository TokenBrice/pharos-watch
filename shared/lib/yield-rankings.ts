interface DedupeYieldRanking {
  id: string;
  currentApy: number;
  pharosYieldScore: number | null;
  apy30d: number;
  sourceTvlUsd: number | null;
}

function score(value: number | null | undefined) {
  return value ?? Number.NEGATIVE_INFINITY;
}

function isPreferredRanking<T extends DedupeYieldRanking>(candidate: T, current: T) {
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

export function dedupeYieldRankings<T extends DedupeYieldRanking>(rankings: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const ranking of rankings) {
    const current = deduped.get(ranking.id);
    if (!current || isPreferredRanking(ranking, current)) {
      deduped.set(ranking.id, ranking);
    }
  }

  return [...deduped.values()];
}
