import { DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { RATE_LIMITS } from "../lib/rate-limit";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { CoinGeckoMarketChartSchema } from "../lib/external-api-schemas";
import type { StablecoinMeta } from "@shared/types";

export interface PricePoint {
  timestamp: number;
  price: number;
}

/**
 * Known CoinGecko data quality issues: date ranges where above-peg prices
 * are systematic artifacts, not real market events. Prices in these windows
 * that exceed the threshold are dropped before depeg detection.
 */
const CG_ABOVE_PEG_EXCLUSIONS: { coinId: string; from: number; to: number; maxPrice: number }[] = [
  // USDT Jul-Aug 2018: CG reports $1.05-$1.50 from illiquid exchange aggregation
  { coinId: "usdt-tether", from: 1531000000, to: 1534000000, maxPrice: 1.02 },
];

export function collapsePricesToDailyTimestamps(prices: PricePoint[]): number[] {
  const byDay = new Map<string, number>();
  for (const point of prices) {
    const day = new Date(point.timestamp * 1000).toISOString().slice(0, 10);
    if (!byDay.has(day)) {
      byDay.set(day, point.timestamp);
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a - b);
}

export async function fetchCgPriceHistoryDaily(geckoId: string): Promise<PricePoint[]> {
  try {
    const res = await fetchWithRetry(
      cgUrl(`/coins/${geckoId}/market_chart?vs_currency=usd&days=max`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
      2,
      { timeoutMs: 30_000 },
    );
    if (!res) return [];
    const raw = await res.json();
    const parsed = CoinGeckoMarketChartSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[backfill-depegs] CG market chart validation failed:", parsed.error.message);
      return [];
    }
    const data = parsed.data;
    return data.prices
      .filter(([, p]) => p > 0)
      .map(([ts, price]) => ({ timestamp: Math.floor(ts / 1000), price }));
  } catch (err) {
    console.error(`[backfill-depegs] Failed to fetch CG daily price history for ${geckoId}:`, err);
    return [];
  }
}

/**
 * Fetch CG price history with hourly granularity using market_chart/range.
 * CG auto-granularity: ranges <=90 days return hourly data on the Analyst plan.
 * Phase 1: single request 2014-01-01 -> 2018-01-30 (daily, pre-hourly epoch)
 * Phase 2: 89-day chunks from 2018-01-30 -> now (hourly)
 * Falls back to fetchCgPriceHistoryDaily if 0 points returned.
 */
export async function fetchCgPriceHistoryHourly(geckoId: string): Promise<PricePoint[]> {
  const seen = new Map<number, number>(); // timestamp → price (dedup)

  const HOURLY_EPOCH = Math.floor(new Date("2018-01-30T00:00:00Z").getTime() / 1000);
  const CHUNK_DAYS = 89;
  const CHUNK_SEC = CHUNK_DAYS * DAY_SECONDS;

  // Phase 1: pre-hourly epoch — single request returns daily data
  try {
    const from = Math.floor(new Date("2014-01-01T00:00:00Z").getTime() / 1000);
    await new Promise(r => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
    const res = await fetchWithRetry(
      cgUrl(`/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${HOURLY_EPOCH}&precision=full`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
      2,
      { timeoutMs: 30_000 },
    );
    if (res) {
      const raw = await res.json();
      const parsed = CoinGeckoMarketChartSchema.safeParse(raw);
      if (parsed.success) {
        for (const [tsMs, p] of parsed.data.prices) {
          if (p > 0) seen.set(Math.floor(tsMs / 1000), p);
        }
      } else {
        console.warn("[backfill-depegs] CG hourly phase-1 validation failed:", parsed.error.message);
      }
    }
  } catch (err) {
    console.error(`[backfill-depegs] CG hourly phase-1 failed for ${geckoId}:`, err);
    // continue — partial data > no data
  }

  // Phase 2: 89-day chunks from hourly epoch to now
  const nowSec = Math.floor(Date.now() / 1000);
  for (let chunkFrom = HOURLY_EPOCH; chunkFrom < nowSec; chunkFrom += CHUNK_SEC) {
    const chunkTo = Math.min(chunkFrom + CHUNK_SEC, nowSec);
    try {
      await new Promise(r => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
      const res = await fetchWithRetry(
        cgUrl(`/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${chunkFrom}&to=${chunkTo}&precision=full`),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
        2,
        { timeoutMs: 30_000 },
      );
      if (res) {
        const raw = await res.json();
        const parsed = CoinGeckoMarketChartSchema.safeParse(raw);
        if (parsed.success) {
          for (const [tsMs, p] of parsed.data.prices) {
            if (p > 0) seen.set(Math.floor(tsMs / 1000), p);
          }
        } else {
          console.warn("[backfill-depegs] CG hourly phase-2 validation failed:", parsed.error.message);
        }
      }
    } catch (err) {
      console.error(`[backfill-depegs] CG hourly chunk failed for ${geckoId} (${chunkFrom}-${chunkTo}):`, err);
      // continue to next chunk — partial data > no data
    }
  }

  if (seen.size === 0) {
    // Fallback to daily endpoint
    return fetchCgPriceHistoryDaily(geckoId);
  }

  return Array.from(seen.entries())
    .map(([timestamp, price]) => ({ timestamp, price }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** DefiLlama chart fallback (~800 daily points per call, ~4 years with two calls). */
export async function fetchDlPriceChart(coinId: string, start: number): Promise<PricePoint[]> {
  try {
    const res = await fetch(
      `${DEFILLAMA_COINS}/chart/${coinId}?start=${start}&span=800&period=1d`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      coins: Record<string, { prices: PricePoint[] }>;
    };
    return data.coins?.[coinId]?.prices ?? [];
  } catch (err) {
    console.error(`[backfill-depegs] DL fallback failed for ${coinId}:`, err);
    return [];
  }
}

export async function fetchMarketBackfillPrices(
  meta: StablecoinMeta,
  geckoId: string,
): Promise<PricePoint[] | null> {
  let prices = await fetchCgPriceHistoryHourly(geckoId);
  // Fall back to DefiLlama if CG has no data (~4 year coverage)
  if (prices.length === 0) {
    const coinId = `coingecko:${geckoId}`;
    const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * DAY_SECONDS;
    const fourYearsAgo = twoYearsAgo - 2 * 365 * DAY_SECONDS;
    const [pricesOld, pricesRecent] = await Promise.all([
      fetchDlPriceChart(coinId, fourYearsAgo),
      fetchDlPriceChart(coinId, twoYearsAgo),
    ]);
    const priceMap = new Map<number, number>();
    for (const p of [...pricesOld, ...pricesRecent]) {
      priceMap.set(p.timestamp, p.price);
    }
    prices = Array.from(priceMap.entries())
      .map(([timestamp, price]) => ({ timestamp, price }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  if (prices.length === 0) return null; // neither source has data

  // Filter out known CG data quality issues for this coin
  const exclusions = CG_ABOVE_PEG_EXCLUSIONS.filter((e) => e.coinId === meta.id);
  if (exclusions.length > 0) {
    prices = prices.filter((p) => {
      for (const ex of exclusions) {
        if (p.timestamp >= ex.from && p.timestamp <= ex.to && p.price > ex.maxPrice) return false;
      }
      return true;
    });
  }

  return prices;
}
