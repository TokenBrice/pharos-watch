export interface PsiComponentsLike {
  severity: number;
  breadth: number;
  stressBreadth?: number;
  trend: number;
}

export interface PsiCurrentLike {
  score: number;
  band: string;
  avg24h?: number;
  avg24hBand?: string;
  computedAt: number;
  components?: PsiComponentsLike;
}

export interface PsiHistoryPointLike {
  date: number;
  score: number;
  band: string;
}

export function getDisplayedPsi(current: PsiCurrentLike): { score: number; band: string } {
  return {
    score: current.avg24h ?? current.score,
    band: current.avg24hBand ?? current.band,
  };
}

export function getPsiTodayMidnight(computedAt: number): number {
  return computedAt - (computedAt % 86_400);
}

export function getCompletedPsiHistory<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
): T[] {
  const todayMidnight = getPsiTodayMidnight(currentComputedAt);
  return history.filter((point) => point.date < todayMidnight);
}

export function getPsiBandStreak<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
  band: string,
): number {
  let streak = 1;
  for (const point of getCompletedPsiHistory(history, currentComputedAt)) {
    if (point.band !== band) break;
    streak++;
  }
  return streak;
}

export function getPsiCompletedDayPoint<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
  daysAgo: number,
): T | null {
  if (daysAgo < 1) return null;
  const completed = getCompletedPsiHistory(history, currentComputedAt);
  return completed[daysAgo - 1] ?? null;
}

export function upsertPsiHistoryPoint<T extends PsiHistoryPointLike>(
  history: T[],
  point: T,
): T[] {
  return [point, ...history.filter((entry) => entry.date !== point.date)];
}
