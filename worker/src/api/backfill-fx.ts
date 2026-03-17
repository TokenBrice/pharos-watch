import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { COMMODITY_MEDIAN_EXCLUDES } from "@shared/lib/peg-rates";
import { USER_AGENT } from "../lib/constants";
import { binarySearchNearest } from "../lib/binary-search";
import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache } from "../lib/db-cache";
import { FrankfurterTimeSeriesSchema } from "../lib/external-api-schemas";
import { fetchCgPriceHistoryHourly } from "./backfill-price-sources";

const SECONDARY_FX_FETCH_CONCURRENCY = 8;

// ── Historical FX rate support ──────────────────────────────────────

/** Maps pegCurrency → frankfurter currency code (ECB-published) */
export const PEG_TO_FX: Record<string, string> = {
  EUR: "EUR",
  GBP: "GBP",
  CHF: "CHF",
  BRL: "BRL",
  JPY: "JPY",
  IDR: "IDR",
  SGD: "SGD",
  TRY: "TRY",
  AUD: "AUD",
  ZAR: "ZAR",
  CAD: "CAD",
  CNY: "CNY",
  PHP: "PHP",
  MXN: "MXN",
};

/** Maps pegCurrency → secondary currency-api code for non-ECB historical FX */
export const SECONDARY_PEG_TO_FX: Record<string, string> = {
  CNH: "CNH",
  RUB: "RUB",
  UAH: "UAH",
  ARS: "ARS",
};

/** Maps coin ID → historical FX code override for OTHER-pegged coins */
export const OTHER_COIN_FX: Record<string, string> = {
  "xsgd-straitsx": "SGD",  // XSGD
  "gyen-gyen": "JPY",  // GYEN
  "audd-novatti": "AUD",  // AUDD
};

/** Commodity peg currencies that need spot price history */
export const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);

export interface FxTimeSeries {
  timestamp: number; // unix seconds
  rate: number;      // USD per unit
}

interface SecondaryFxResponse {
  date?: string;
  usd?: Record<string, number>;
}

/**
 * Fetch daily historical FX rates from frankfurter.app (ECB data).
 * Returns USD-per-unit time series keyed by currency code.
 * On failure, returns {} — callers fall back to current rates.
 */
export async function fetchHistoricalFxRates(
  currencies: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, FxTimeSeries[]>> {
  if (currencies.length === 0) return {};
  try {
    const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${currencies.join(",")}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.error(`[backfill-depegs] frankfurter.app returned ${res.status}`);
      return {};
    }
    const raw = await res.json();
    const parsed = FrankfurterTimeSeriesSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[backfill-depegs] Frankfurter validation failed:", parsed.error.message);
      return {};
    }
    const data = parsed.data;

    const result: Record<string, FxTimeSeries[]> = {};
    for (const currency of currencies) {
      result[currency] = [];
    }

    // data.rates is keyed by date string "YYYY-MM-DD"
    for (const [dateStr, dayRates] of Object.entries(data.rates)) {
      const ts = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
      for (const [currency, unitsPerUsd] of Object.entries(dayRates)) {
        if (unitsPerUsd > 0 && result[currency]) {
          result[currency].push({ timestamp: ts, rate: 1 / unitsPerUsd });
        }
      }
    }

    // Sort each series by timestamp
    for (const series of Object.values(result)) {
      series.sort((a, b) => a.timestamp - b.timestamp);
    }

    return result;
  } catch (err) {
    console.error(`[backfill-depegs] FX fetch failed:`, err);
    return {};
  }
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

export function mergeDateRates(target: Record<string, Record<string, number>>, date: string, rates: Record<string, number> | null): void {
  if (!rates) return;
  target[date] = {
    ...(target[date] ?? {}),
    ...rates,
  };
}

async function fetchHistoricalSecondaryFxDay(date: string): Promise<Record<string, number> | null> {
  const primaryUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`;
  const fallbackUrl = `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`;

  let res = await fetchWithRetry(primaryUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!res || !res.ok) {
    res = await fetchWithRetry(fallbackUrl, { headers: { "User-Agent": USER_AGENT } });
  }
  if (!res || !res.ok) {
    console.warn(`[backfill-depegs] secondary FX API returned ${res?.status ?? "no response"} for ${date}`);
    return null;
  }

  const data = await res.json() as SecondaryFxResponse;
  return data.usd ?? null;
}

export async function fetchHistoricalSecondaryFxRates(
  db: D1Database,
  currencies: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, FxTimeSeries[]>> {
  if (currencies.length === 0) return {};

  const normalized = Array.from(new Set(currencies.map((currency) => currency.toUpperCase())));
  const result: Record<string, FxTimeSeries[]> = Object.fromEntries(
    normalized.map((currency) => [currency, []]),
  );

  const startYear = Number.parseInt(startDate.slice(0, 4), 10);
  const endYear = Number.parseInt(endDate.slice(0, 4), 10);

  for (let year = startYear; year <= endYear; year++) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const rangeStart = startDate > yearStart ? startDate : yearStart;
    const rangeEnd = endDate < yearEnd ? endDate : yearEnd;
    const wantedDates = enumerateDates(rangeStart, rangeEnd);

    const cacheKey = `fx-history-secondary:${year}`;
    let yearCache: Record<string, Record<string, number>> = {};
    const cached = await getCache(db, cacheKey);
    if (cached) {
      try {
        yearCache = JSON.parse(cached.value) as Record<string, Record<string, number>>;
      } catch {
        yearCache = {};
      }
    }

    const missingDates = wantedDates.filter((date) => !yearCache[date]);
    for (let i = 0; i < missingDates.length; i += SECONDARY_FX_FETCH_CONCURRENCY) {
      const chunk = missingDates.slice(i, i + SECONDARY_FX_FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        chunk.map(async (date) => [date, await fetchHistoricalSecondaryFxDay(date)] as const),
      );
      for (const [date, dailyRates] of fetched) {
        mergeDateRates(yearCache, date, dailyRates);
      }
    }

    if (missingDates.length > 0) {
      await setCache(db, cacheKey, JSON.stringify(yearCache));
    }

    for (const date of wantedDates) {
      const dailyRates = yearCache[date];
      if (!dailyRates) continue;

      const timestamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      for (const currency of normalized) {
        const unitsPerUsd = dailyRates[currency.toLowerCase()];
        if (typeof unitsPerUsd !== "number" || unitsPerUsd <= 0) continue;
        result[currency].push({ timestamp, rate: 1 / unitsPerUsd });
      }
    }
  }

  for (const currency of normalized) {
    result[currency]?.sort((a, b) => a.timestamp - b.timestamp);
  }

  return result;
}

/**
 * Build a commodity peg reference time series from the peer-median of all tracked
 * gold/silver token CG prices, bucketed by day.
 *
 * This mirrors derivePegRates() in the live system: gold/silver tokens are tightly
 * arbitraged, so their median price is a reliable spot reference. metals.dev daily
 * prices can diverge from CG market prices by 3–5% on days with large intraday moves,
 * causing false depeg events for every gold token simultaneously.
 */
export async function buildCommodityMedianSeriesFromCg(): Promise<Record<string, FxTimeSeries[]>> {
  const result: Record<string, FxTimeSeries[]> = { GOLD: [], SILVER: [] };

  const allCommodityCoins = ACTIVE_STABLECOINS.filter(
    (m) => COMMODITY_PEGS.has(m.flags.pegCurrency) && !m.flags.navToken
      && !COMMODITY_MEDIAN_EXCLUDES.has(m.id)
  );

  // Per-coin per-day mean prices (normalised to per-troy-oz).
  // CG days=max returns different granularities per coin (daily for old coins,
  // hourly/5-min for newer ones), so we must aggregate per-coin first to give
  // each coin equal weight in the cross-coin daily median.
  const coinDailies: Record<string, Map<number, number>[]> = { GOLD: [], SILVER: [] };

  for (const meta of allCommodityCoins) {
    const geckoId = TRACKED_META_BY_ID.get(meta.id)?.geckoId;
    if (!geckoId) continue;
    const prices = await fetchCgPriceHistoryHourly(geckoId);
    if (prices.length === 0) continue;

    const oz = meta.commodityOunces;
    const peg = meta.flags.pegCurrency;
    const arr = coinDailies[peg];
    if (!arr) continue;

    // Bucket this coin's prices by day, compute daily mean
    const dayBuckets = new Map<number, { sum: number; count: number }>();
    for (const p of prices) {
      const perOz = oz && oz > 0 ? p.price / oz : p.price;
      const day = Math.floor(p.timestamp / DAY_SECONDS) * DAY_SECONDS;
      const bucket = dayBuckets.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += perOz;
      bucket.count++;
      dayBuckets.set(day, bucket);
    }

    const dailyMean = new Map<number, number>();
    for (const [day, { sum, count }] of dayBuckets) {
      dailyMean.set(day, sum / count);
    }
    arr.push(dailyMean);
  }

  // Cross-coin median: for each day, collect one mean per coin, take the median
  for (const peg of ["GOLD", "SILVER"] as const) {
    const coinMaps = coinDailies[peg];
    if (coinMaps.length === 0) continue;

    // Collect all days that appear in any coin's data
    const allDays = new Set<number>();
    for (const m of coinMaps) for (const d of m.keys()) allDays.add(d);

    const series: FxTimeSeries[] = [];
    for (const day of allDays) {
      const vals: number[] = [];
      for (const m of coinMaps) {
        const v = m.get(day);
        if (v !== undefined) vals.push(v);
      }
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      const median =
        vals.length % 2 === 0
          ? (vals[mid - 1] + vals[mid]) / 2
          : vals[mid];
      series.push({ timestamp: day, rate: median });
    }
    series.sort((a, b) => a.timestamp - b.timestamp);
    result[peg] = series;
    console.log(`[backfill-depegs] Commodity median (${peg}): ${series.length} daily points from ${coinMaps.length} tokens`);
  }

  return result;
}

/**
 * Build a lookup function that returns the FX rate (USD per unit) at a given
 * timestamp, using binary search nearest-neighbor on the daily ECB series.
 * If the series is empty, returns the static fallback.
 */
export function buildFxLookup(series: FxTimeSeries[], fallback: number): (timestamp: number) => number {
  if (series.length === 0) return () => fallback;

  return (timestamp: number): number =>
    binarySearchNearest(series, timestamp, (s) => s.timestamp)?.rate ?? fallback;
}
