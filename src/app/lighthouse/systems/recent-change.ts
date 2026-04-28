import type { StablecoinData } from "@shared/types/market";
import { getCirculatingRaw, getPrevDayRawOrNull, getPrevMonthRawOrNull, getPrevWeekRawOrNull } from "@shared/lib/supply";

export interface RecentChange {
  change24hUsd: number | null;
  change24hPct: number | null;
  change7dUsd: number | null;
  change7dPct: number | null;
  change30dUsd: number | null;
  change30dPct: number | null;
}

function changeFrom(current: number, previous: number | null): { usd: number | null; pct: number | null } {
  if (previous == null) return { usd: null, pct: null };
  const usd = current - previous;
  return { usd, pct: previous > 0 ? (usd / previous) * 100 : null };
}

export function getRecentChange(asset: StablecoinData): RecentChange {
  const current = getCirculatingRaw(asset);
  const day = changeFrom(current, getPrevDayRawOrNull(asset));
  const week = changeFrom(current, getPrevWeekRawOrNull(asset));
  const month = changeFrom(current, getPrevMonthRawOrNull(asset));
  return {
    change24hUsd: day.usd,
    change24hPct: day.pct,
    change7dUsd: week.usd,
    change7dPct: week.pct,
    change30dUsd: month.usd,
    change30dPct: month.pct,
  };
}
