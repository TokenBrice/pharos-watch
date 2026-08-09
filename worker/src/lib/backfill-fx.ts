import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { COMMODITY_MEDIAN_EXCLUDES } from "@shared/lib/peg-rates";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { buildCommodityPeerMedianSeries, type CommodityPeg } from "@shared/lib/commodity-median";
import {
  enumerateDates,
  interpolateRateAtTimestamp,
  mergeDateRates,
  type TimestampedRatePoint,
} from "@shared/lib/rate-series";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry";
import { getCache, setCache } from "./db-cache";
import { FrankfurterTimeSeriesSchema, SecondaryFxResponseSchema } from "./external-api-schemas";
import { rethrowIfAborted } from "./abort";
import { mapWithConcurrency } from "./concurrency";
import type { D1Database } from "@cloudflare/workers-types";
import { fetchCgPriceHistoryHourly, type HistoricalMarketBackfillRange } from "../api/backfill-price-sources";

const SECONDARY_FX_FETCH_CONCURRENCY = 8;
const COMMODITY_MEDIAN_FETCH_CONCURRENCY = 6;

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
  MYR: "MYR",
  KRW: "KRW",
};

/** Maps pegCurrency → secondary currency-api code for non-ECB historical FX */
export const SECONDARY_PEG_TO_FX: Record<string, string> = {
  CNH: "CNH",
  RUB: "RUB",
  UAH: "UAH",
  ARS: "ARS",
  KGS: "KGS",
  NGN: "NGN",
  XOF: "XOF",
  VND: "VND",
};

/** Maps coin ID → historical FX code override for OTHER-pegged coins */
export const OTHER_COIN_FX: Record<string, string> = {
  "xsgd-straitsx": "SGD",  // XSGD
  "gyen-gyen": "JPY",  // GYEN
  "audd-novatti": "AUD",  // AUDD
};

export type FxTimeSeries = TimestampedRatePoint;
export type { CommodityPeg } from "@shared/lib/commodity-median";

/**
 * Fetch daily historical FX rates from api.frankfurter.dev (ECB data).
 * Returns USD-per-unit time series keyed by currency code.
 * On failure, returns {} — callers fall back to current rates.
 */
export async function fetchHistoricalFxRates(
  currencies: string[],
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<Record<string, FxTimeSeries[]>> {
  if (currencies.length === 0) return {};
  try {
    const url = `https://api.frankfurter.dev/v1/${startDate}..${endDate}?base=USD&symbols=${currencies.join(",")}`;
    const fetchResult = await fetchJsonWithRetry<unknown>(
      url,
      { headers: { "User-Agent": USER_AGENT }, signal },
      2,
      { timeoutMs: 30_000 },
    );
    if (!fetchResult?.response.ok) {
      console.error(`[backfill-depegs] Frankfurter API returned ${fetchResult?.response.status ?? "no response"}`);
      return {};
    }
    const raw = fetchResult.body;
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
    rethrowIfAborted(err, signal);
    console.error(`[backfill-depegs] FX fetch failed:`, err);
    return {};
  }
}

async function fetchHistoricalSecondaryFxDay(date: string, signal?: AbortSignal): Promise<Record<string, number> | null> {
  const primaryUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`;
  const fallbackUrl = `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`;

  let result = await fetchTextWithRetry(
    primaryUrl,
    { headers: { "User-Agent": USER_AGENT }, signal },
    2,
    { passthrough404: true, timeoutMs: 20_000 },
  );
  if (!result?.response.ok) {
    result = await fetchTextWithRetry(
      fallbackUrl,
      { headers: { "User-Agent": USER_AGENT }, signal },
      2,
      { passthrough404: true, timeoutMs: 20_000 },
    );
  }
  if (!result?.response.ok) {
    console.warn(`[backfill-depegs] secondary FX API returned ${result?.response.status ?? "no response"} for ${date}`);
    return null;
  }

  const raw = JSON.parse(result.body) as unknown;
  const parsed = SecondaryFxResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[backfill-depegs] secondary FX validation failed for ${date}: ${parsed.error.message}`);
    return null;
  }
  return parsed.data.usd ?? null;
}

export async function fetchHistoricalSecondaryFxRates(
  db: D1Database,
  currencies: string[],
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
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
        chunk.map(async (date) => [date, await fetchHistoricalSecondaryFxDay(date, signal)] as const),
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
export async function buildCommodityMedianSeriesFromCg(
  range?: HistoricalMarketBackfillRange,
  coingeckoApiKey: string | null = null,
  pegs: readonly CommodityPeg[] = ["GOLD", "SILVER"],
): Promise<Record<string, FxTimeSeries[]>> {
  const pegSet = new Set<string>(pegs);
  const allCommodityCoins = ACTIVE_STABLECOINS.filter(
    (m) => pegSet.has(m.flags.pegCurrency) && isCommodityPeg(m.flags.pegCurrency) && !m.flags.navToken
      && !COMMODITY_MEDIAN_EXCLUDES.has(m.id),
  );
  const sources: Array<{
    peg: CommodityPeg;
    commodityOunces?: number | null;
    prices: { timestamp: number; price: number }[];
  }> = [];

  await mapWithConcurrency(allCommodityCoins, COMMODITY_MEDIAN_FETCH_CONCURRENCY, async (meta) => {
    const geckoId = TRACKED_META_BY_ID.get(meta.id)?.geckoId;
    if (!geckoId) return;
    const prices = await fetchCgPriceHistoryHourly(geckoId, range, "usd", coingeckoApiKey);
    if (prices.length === 0) return;
    sources.push({
      peg: meta.flags.pegCurrency as CommodityPeg,
      commodityOunces: meta.commodityOunces,
      prices,
    });
  });

  const result = buildCommodityPeerMedianSeries(sources);
  for (const peg of ["GOLD", "SILVER"] as const) {
    const tokenCount = sources.filter((source) => source.peg === peg).length;
    if (tokenCount > 0) {
      console.log(`[backfill-depegs] Commodity median (${peg}): ${result[peg].length} daily points from ${tokenCount} tokens`);
    }
  }

  return result;
}

/**
 * Build a lookup function that returns the FX rate (USD per unit) at a given
 * timestamp, using linear interpolation between the two surrounding daily ECB
 * snapshots.  Nearest-neighbor caused up to 12 h timing mismatch with hourly
 * CoinGecko prices, adding ~50-80 bps of noise that inflated non-USD depeg
 * event counts.  Linear interpolation reduces that error to ~5-15 bps.
 *
 * Outside the series range the boundary rate is returned (no extrapolation).
 * If the series is empty, returns the static fallback.
 */
export function buildFxLookup(series: FxTimeSeries[], fallback: number): (timestamp: number) => number {
  if (series.length === 0) return () => fallback;

  return (timestamp: number): number => {
    return interpolateRateAtTimestamp(series, timestamp) ?? fallback;
  };
}
