import { DAY_SECONDS } from "./time-constants";

export interface TimestampedRatePoint {
  timestamp: number;
  rate: number;
}

export function interpolateRateAtTimestamp(
  series: readonly TimestampedRatePoint[],
  timestamp: number,
): number | null {
  if (series.length === 0) return null;
  if (timestamp <= series[0].timestamp) return series[0].rate;
  if (timestamp >= series[series.length - 1].timestamp) return series[series.length - 1].rate;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }

  if (series[lo].timestamp === timestamp) return series[lo].rate;

  const prev = series[lo - 1];
  const next = series[lo];
  const t = (timestamp - prev.timestamp) / (next.timestamp - prev.timestamp);
  return prev.rate + t * (next.rate - prev.rate);
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function mergeDateRates(
  target: Record<string, Record<string, number>>,
  date: string,
  rates: Record<string, number> | null,
): void {
  if (!rates) return;
  target[date] = {
    ...(target[date] ?? {}),
    ...rates,
  };
}

export function bucketTimestampToUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS;
}
