import { DAY_SECONDS } from "./time-constants";
import { bucketUnixSecondsToUtcDay } from "./time-buckets";

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

export interface PsiChartPoint {
  ts: number;
  score: number;
}

export interface PsiCurrentChartLike {
  computedAt: number;
  score: number;
}

export function getDisplayedPsi(current: PsiCurrentLike): { score: number; band: string } {
  return {
    score: current.avg24h ?? current.score,
    band: current.avg24hBand ?? current.band,
  };
}

export function getDisplayedPsiBasis(current: PsiCurrentLike): "rolling 24h avg" | "raw instant" {
  return current.avg24h != null ? "rolling 24h avg" : "raw instant";
}

function getPsiTodayMidnight(computedAt: number): number {
  return bucketUnixSecondsToUtcDay(computedAt);
}

function completedPsiHistoryByDate<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
): Map<number, T> {
  const todayMidnight = getPsiTodayMidnight(currentComputedAt);
  const byDate = new Map<number, T>();
  for (const point of history) {
    if (point.date >= todayMidnight || byDate.has(point.date)) continue;
    byDate.set(point.date, point);
  }
  return byDate;
}

/**
 * Band streak for the current (in-progress) row plus consecutive completed
 * calendar days. Counting rows instead of days lets one skipped snapshot
 * shift "yesterday" onto an older row and inflate the streak across the gap;
 * resolving each step by its exact UTC date stops at the first missing day.
 */
export function getPsiBandStreak<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
  band: string,
): number {
  const completedByDate = completedPsiHistoryByDate(history, currentComputedAt);
  const todayMidnight = getPsiTodayMidnight(currentComputedAt);
  let streak = 1;
  for (let daysAgo = 1; ; daysAgo += 1) {
    const point = completedByDate.get(todayMidnight - daysAgo * DAY_SECONDS);
    if (!point || point.band !== band) break;
    streak += 1;
  }
  return streak;
}

export function getPsiCompletedDayPoint<T extends PsiHistoryPointLike>(
  history: T[],
  currentComputedAt: number,
  daysAgo: number,
): T | null {
  if (daysAgo < 1) return null;
  return completedPsiHistoryByDate(history, currentComputedAt)
    .get(getPsiTodayMidnight(currentComputedAt) - daysAgo * DAY_SECONDS) ?? null;
}

export function upsertPsiHistoryPoint<T extends PsiHistoryPointLike>(
  history: T[],
  point: T,
): T[] {
  return [point, ...history.filter((entry) => entry.date !== point.date)];
}

export function buildPsiChartData<T extends PsiHistoryPointLike>(
  history: readonly T[] | null | undefined,
  current: PsiCurrentChartLike | null | undefined,
): PsiChartPoint[] {
  if (!current || !history) return [];
  const reversed = [...history].reverse();
  return [
    ...reversed.map((point) => ({ ts: point.date * 1000, score: point.score })),
    { ts: current.computedAt * 1000, score: current.score },
  ];
}
