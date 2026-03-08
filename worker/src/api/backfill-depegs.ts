import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates, getPegReference, COMMODITY_MEDIAN_EXCLUDES } from "@shared/lib/peg-rates";
import { getDepegThresholdBps, DEFILLAMA_COINS, DEFILLAMA_BASE, RUB_FALLBACK, USER_AGENT, DEPEG_CONFIRMATION_SUPPLY_THRESHOLD } from "../lib/constants";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
  type PriceReasonablenessOptions,
} from "../cron/enrich-prices";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { binarySearchNearest } from "../lib/binary-search";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RATE_LIMITS } from "../lib/rate-limit";
import { getCache, setCache } from "../lib/db";
import type { StablecoinMeta } from "@shared/types";
import { sumPegBuckets } from "@shared/lib/supply";
import { noCoinsInBatchResponse, selectBackfillCoins } from "../lib/backfill-query";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;
const SECONDARY_FX_FETCH_CONCURRENCY = 8;

/** Consecutive above-threshold data points needed to confirm a large-cap depeg.
 *  Mirrors the live system's pending → re-check → promote flow. */
const BACKFILL_MIN_CONFIRM_POINTS = 2;

/** Max gap (seconds) between data points before pending resets.
 *  6h handles CG hourly gaps but resets for day-scale gaps. */
const BACKFILL_PENDING_MAX_GAP_SEC = 6 * 3600;

// ── Historical FX rate support ──────────────────────────────────────

/** Maps pegCurrency → frankfurter currency code (ECB-published) */
const PEG_TO_FX: Record<string, string> = {
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
const SECONDARY_PEG_TO_FX: Record<string, string> = {
  CNH: "CNH",
  RUB: "RUB",
  UAH: "UAH",
  ARS: "ARS",
};

/** Maps coin ID → historical FX code override for OTHER-pegged coins */
const OTHER_COIN_FX: Record<string, string> = {
  "xsgd-straitsx": "SGD",  // XSGD
  "gyen-gyen": "JPY",  // GYEN
  "audd-novatti": "AUD",  // AUDD
};

/** Commodity peg currencies that need spot price history */
const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);


interface FxTimeSeries {
  timestamp: number; // unix seconds
  rate: number;      // USD per unit
}

interface FrankfurterTimeSeriesResponse {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>; // date → { currency: unitsPerUSD }
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
async function fetchHistoricalFxRates(
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
    const data: FrankfurterTimeSeriesResponse = await res.json();

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

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function mergeDateRates(target: Record<string, Record<string, number>>, date: string, rates: Record<string, number> | null): void {
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
async function buildCommodityMedianSeriesFromCg(): Promise<Record<string, FxTimeSeries[]>> {
  const result: Record<string, FxTimeSeries[]> = { GOLD: [], SILVER: [] };

  const allCommodityCoins = TRACKED_STABLECOINS.filter(
    (m) => COMMODITY_PEGS.has(m.flags.pegCurrency) && !m.flags.navToken
      && !COMMODITY_MEDIAN_EXCLUDES.has(m.id)
  );

  // Per-coin per-day mean prices (normalised to per-troy-oz).
  // CG days=max returns different granularities per coin (daily for old coins,
  // hourly/5-min for newer ones), so we must aggregate per-coin first to give
  // each coin equal weight in the cross-coin daily median.
  const DAY = 86400;
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
      const day = Math.floor(p.timestamp / DAY) * DAY;
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

interface PricePoint {
  timestamp: number;
  price: number;
}

interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
}

/** Per-coin detail from /stablecoin/:id — includes gecko_id and historical supply */
interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyByDate: SupplySnapshot[];
}

export const handleBackfillDepegs = withErrorHandler("backfill-depegs", async (db: D1Database, url: URL, adminSecret?: string, request?: Request): Promise<Response> => {
  return withAdmin(request, adminSecret, async () => {

    const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
      defaultBatchSize: BATCH_SIZE,
      allowBatchSizeOverride: false,
    });
    if ("response" in selection) {
      return selection.response;
    }
    const coins = selection.coins;

    if (coins.length === 0) {
      return noCoinsInBatchResponse();
    }

  // Get peg rates from cached stablecoin data
  let pegRates: Record<string, number> = { peggedUSD: 1 };
  let fxRates: Record<string, number> | undefined;

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCache.ok && stablecoinsCache.warningReason) {
    console.warn(`[backfill-depegs] stablecoins cache fallback (${stablecoinsCache.warningReason})`);
  } else if (!stablecoinsCache.ok) {
    console.warn(`[backfill-depegs] stablecoins cache unavailable (${stablecoinsCache.reason})`);
  }
  if (stablecoinsCache.ok) {
    const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map((s) => [s.id, s]));
    ({ rates: pegRates } = derivePegRates(
      stablecoinsCache.payload.peggedAssets,
      metaById,
      stablecoinsCache.payload.fxFallbackRates,
    ));
    fxRates = stablecoinsCache.payload.fxFallbackRates;
  }

  // Filter to processable coins (skip NAV tokens)
  const processable = coins.filter(
    (m) => !m.flags.navToken
  );

  // Manual overrides for coins where DefiLlama has wrong/missing geckoId

  let totalEvents = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  // Collect coin details and historical FX currencies needed by this batch
  const neededFxCurrencies = new Set<string>();
  const neededSecondaryFxCurrencies = new Set<string>();
  let needsCommodities = false;
  const preparedCoins: PreparedBackfillCoin[] = [];

  // Fetch historical FX rates only as far back as the oldest supply snapshot in this batch.
  // If supply history is missing, fall back to 10 years to preserve current behavior.
  const tenYearsAgoMs = Date.now() - 10 * 365 * 86400 * 1000;
  const defaultStartDate = new Date(tenYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  let historicalFxStartDate = endDate;

  for (const meta of processable) {
    let detail: CoinDetail | null = null;
    const dlId = meta.llamaId ?? meta.id;
    try {
      const res = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`);
      if (res.ok) {
        detail = (await res.json()) as CoinDetail;
      }
    } catch (err) {
      console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
    }

    const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
    const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
    const supplyByDate = parseSupplyData(detail?.tokens ?? []);
    preparedCoins.push({ meta, geckoId, supplyByDate });

    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;

    let earliestDate: string;
    if (supplyByDate[0]) {
      earliestDate = new Date(supplyByDate[0].ts * 1000).toISOString().slice(0, 10);
    } else if (SECONDARY_PEG_TO_FX[peg] && geckoId) {
      // Secondary FX coins with no DL supply data would otherwise default to 10 years,
      // triggering ~3,600 per-day CDN fetches for the cold-start FX cache build.
      // Fetch the CG ATL/genesis date to anchor the window to the coin's actual inception.
      try {
        await new Promise(r => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
        const cgRes = await fetchWithRetry(
          cgUrl(`/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`),
          { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
          1,
          { timeoutMs: 10_000 },
        );
        if (cgRes?.ok) {
          const cgData = await cgRes.json() as {
            genesis_date?: string | null;
            market_data?: { atl_date?: Record<string, string> };
          };
          const inceptionStr = cgData.genesis_date ?? cgData.market_data?.atl_date?.["usd"];
          if (inceptionStr) {
            const d = new Date(inceptionStr);
            d.setUTCDate(d.getUTCDate() - 7); // 7-day buffer
            earliestDate = d.toISOString().slice(0, 10);
          } else {
            earliestDate = defaultStartDate;
          }
        } else {
          earliestDate = defaultStartDate;
        }
      } catch {
        earliestDate = defaultStartDate;
      }
    } else {
      earliestDate = defaultStartDate;
    }
    if (earliestDate < historicalFxStartDate) {
      historicalFxStartDate = earliestDate;
    }

    if (COMMODITY_PEGS.has(peg)) {
      needsCommodities = true;
    } else {
      const secondaryFx = SECONDARY_PEG_TO_FX[peg];
      if (secondaryFx) {
        neededSecondaryFxCurrencies.add(secondaryFx);
        continue;
      }

      const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      if (fx) {
        neededFxCurrencies.add(fx);
      }
    }
  }

  // Fetch FX rates and commodity peer-median series in parallel.
  // Commodity peg reference is derived from the median of all tracked gold/silver
  // token CG prices — same approach as derivePegRates() in the live system.
  const fxPromise = neededFxCurrencies.size > 0
    ? fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const secondaryFxPromise = neededSecondaryFxCurrencies.size > 0
    ? fetchHistoricalSecondaryFxRates(db, [...neededSecondaryFxCurrencies], historicalFxStartDate, endDate)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const commodityPromise = needsCommodities
    ? buildCommodityMedianSeriesFromCg()
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const [fxSeriesPrimary, fxSeriesSecondary, commoditySeries] = await Promise.all([
    fxPromise,
    secondaryFxPromise,
    commodityPromise,
  ]);
  const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

  // Process coins sequentially — each still needs CG price history fetch.
  // Serializing avoids memory pressure from parsing multiple large JSON responses.
  for (const { meta, geckoId, supplyByDate } of preparedCoins) {
    if (!geckoId) {
      skipped.push(meta.symbol);
      continue;
    }

    // Build time-varying peg reference function for this coin
    const peg = meta.flags.pegCurrency;
    const pegType = `pegged${peg}`;
    const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
    let getPegRef: (timestamp: number) => number;

    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (COMMODITY_PEGS.has(peg)) {
      // Commodity peg (gold/silver): use historical spot price series
      const series = commoditySeries[peg] ?? [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const spotLookup = buildFxLookup(series, fallback);
      if (meta.commodityOunces && meta.commodityOunces > 0) {
        const oz = meta.commodityOunces;
        getPegRef = (ts) => spotLookup(ts) * oz;
      } else {
        getPegRef = spotLookup;
      }
    } else {
      const fxCode = PEG_TO_FX[peg] ?? SECONDARY_PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallbackRate = fxRates?.[pegType];
      const fallback = typeof fallbackRate === "number" && fallbackRate > 0
        ? fallbackRate
        : currentPegRef > 0
          ? currentPegRef
          : peg === "RUB"
            ? RUB_FALLBACK
            : 1;
      const fxLookup = buildFxLookup(series, fallback);
      getPegRef = fxLookup;
    }

    try {
      const events = await backfillCoin(meta, geckoId, getPegRef, supplyByDate, fxRates);

      // null = CG had no price data → preserve existing events
      if (events === null) {
        skipped.push(meta.symbol);
        continue;
      }

      // Only replace backfill-sourced events; preserve live-cron-detected events
      // (live cron catches brief intraday depegs that daily backfill data misses).
      const deleteStmt = db
        .prepare("DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'")
        .bind(meta.id);
      if (events.length > 0) {
        const insertStmts = events.map((e) =>
          db.prepare(
            `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`
          ).bind(
            meta.id, meta.symbol, e.pegType, e.direction, e.peakDeviationBps,
            e.startedAt, e.endedAt, e.startPrice, e.peakPrice, e.recoveryPrice, e.pegRef
          )
        );
        await db.batch([deleteStmt]);
        for (let i = 0; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
          const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
          await db.batch(chunk);
        }
        totalEvents += events.length;
      } else {
        await deleteStmt.run();
      }
    } catch (err) {
      errors.push(`${meta.symbol}: ${err}`);
    }
  }

    return jsonResponse({
      coinsProcessed: coins.length,
      eventsCreated: totalEvents,
      skipped: skipped.length > 0 ? skipped : undefined,
      errors: errors.length > 0 ? errors : undefined,
      commodities: needsCommodities ? {
        goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
        silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
      } : undefined,
    });
  });
});

interface BackfillEvent {
  pegType: string;
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
}

interface SupplySnapshot {
  ts: number;
  supply: number;
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

/** Returns null when neither CG nor DL has price data (caller should preserve existing events). */
async function backfillCoin(
  meta: StablecoinMeta,
  geckoId: string,
  getPegRef: (timestamp: number) => number,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
): Promise<BackfillEvent[] | null> {
  const pegType = `pegged${meta.flags.pegCurrency}`;
  let prices = await fetchCgPriceHistoryHourly(geckoId);
  // Fall back to DefiLlama if CG has no data (~4 year coverage)
  if (prices.length === 0) {
    const coinId = `coingecko:${geckoId}`;
    const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;
    const fourYearsAgo = twoYearsAgo - 2 * 365 * 86400;
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

  return extractDepegEvents(
    prices,
    getPegRef,
    pegType,
    supplyByDate,
    fxRates,
    buildPriceReasonablenessOptions({
      navToken: meta.flags.navToken,
      commodityOunces: meta.commodityOunces,
    }),
  );
}

async function fetchCgPriceHistoryDaily(geckoId: string): Promise<PricePoint[]> {
  try {
    const res = await fetchWithRetry(
      cgUrl(`/coins/${geckoId}/market_chart?vs_currency=usd&days=max`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
      2,
      { timeoutMs: 30_000 },
    );
    if (!res) return [];
    const data = await res.json() as { prices: [number, number][] };
    return (data.prices ?? [])
      .filter(([, p]) => p > 0)
      .map(([ts, price]) => ({ timestamp: Math.floor(ts / 1000), price }));
  } catch (err) {
    console.error(`[backfill-depegs] Failed to fetch CG daily price history for ${geckoId}:`, err);
    return [];
  }
}

/**
 * Fetch CG price history with hourly granularity using market_chart/range.
 * CG auto-granularity: ranges ≤90 days return hourly data on the Analyst plan.
 * Phase 1: single request 2014-01-01 → 2018-01-30 (daily, pre-hourly epoch)
 * Phase 2: 89-day chunks from 2018-01-30 → now (hourly)
 * Falls back to fetchCgPriceHistoryDaily if 0 points returned.
 */
async function fetchCgPriceHistoryHourly(geckoId: string): Promise<PricePoint[]> {
  const seen = new Map<number, number>(); // timestamp → price (dedup)

  const HOURLY_EPOCH = Math.floor(new Date("2018-01-30T00:00:00Z").getTime() / 1000);
  const CHUNK_DAYS = 89;
  const CHUNK_SEC = CHUNK_DAYS * 86400;

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
      const data = await res.json() as { prices: [number, number][] };
      for (const [tsMs, p] of data.prices ?? []) {
        if (p > 0) seen.set(Math.floor(tsMs / 1000), p);
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
        const data = await res.json() as { prices: [number, number][] };
        for (const [tsMs, p] of data.prices ?? []) {
          if (p > 0) seen.set(Math.floor(tsMs / 1000), p);
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
async function fetchDlPriceChart(coinId: string, start: number): Promise<PricePoint[]> {
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

export function parseSupplyData(tokens: SupplyPoint[]): SupplySnapshot[] {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = parseInt(point.date, 10);
    if (isNaN(ts)) continue;
    const supply = sumPegBuckets(point.circulating);
    map.set(ts, supply);
  }
  return Array.from(map.entries())
    .map(([ts, supply]) => ({ ts, supply }))
    .sort((a, b) => a.ts - b.ts);
}

export function findNearestSupply(supplyByDate: SupplySnapshot[], timestamp: number): number | null {
  if (supplyByDate.length === 0) return null;

  let lo = 0;
  let hi = supplyByDate.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (supplyByDate[mid].ts < timestamp) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const candidates = [
    lo > 0 ? supplyByDate[lo - 1] : null,
    lo < supplyByDate.length ? supplyByDate[lo] : null,
  ].filter((x): x is SupplySnapshot => x !== null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.ts - timestamp) - Math.abs(b.ts - timestamp));
  return candidates[0].supply;
}

export function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number,
  pegType: string,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  priceValidationOpts?: PriceReasonablenessOptions,
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;

  // Pending state for large-cap confirmation (mirrors live pending → confirm flow)
  let pending: {
    direction: string;
    count: number;
    firstTs: number;
    lastTs: number;
    peakBps: number;
    startPrice: number;
    peakPrice: number;
    pegRef: number;
  } | null = null;

  /** Promote pending to an active event */
  function promotePending(): void {
    if (!pending) return;
    current = {
      pegType,
      direction: pending.direction,
      peakDeviationBps: pending.peakBps,
      startedAt: pending.firstTs,
      endedAt: null,
      startPrice: pending.startPrice,
      peakPrice: pending.peakPrice,
      recoveryPrice: null,
      pegRef: pending.pegRef,
    };
    pending = null;
  }

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;
    if (!isReasonablePrice(price, pegType, fxRates, priceValidationOpts)) continue;

    if (supplyByDate.length > 0) {
      const supply = findNearestSupply(supplyByDate, timestamp);
      if (supply !== null && supply < 1_000_000) continue;
    }

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";

    // Determine if this coin is large-cap at this point in time
    const supply = findNearestSupply(supplyByDate, timestamp);
    const isLargeCap = supply !== null && supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD;

    if (absBps >= threshold) {
      if (current) {
        if (current.direction !== direction) {
          // Direction change: close current event, fall through to "no event" path below
          current.endedAt = timestamp;
          current.recoveryPrice = price;
          events.push(current);
          current = null;
          // fall through — will be handled as "no active event" below
        } else {
          // Same direction: update peak, continue
          if (absBps > Math.abs(current.peakDeviationBps)) {
            current.peakDeviationBps = bps;
            current.peakPrice = price;
          }
          continue;
        }
      }

      // No active event — decide whether to open immediately or require confirmation
      if (!isLargeCap) {
        // Small cap: instant event (existing behavior)
        current = {
          pegType,
          direction,
          peakDeviationBps: bps,
          startedAt: timestamp,
          endedAt: null,
          startPrice: price,
          peakPrice: price,
          recoveryPrice: null,
          pegRef,
        };
        pending = null;
      } else {
        // Large cap: require consecutive confirmation points
        if (!pending || pending.direction !== direction
            || (timestamp - pending.lastTs) > BACKFILL_PENDING_MAX_GAP_SEC) {
          // Start new pending
          pending = {
            direction,
            count: 1,
            firstTs: timestamp,
            lastTs: timestamp,
            peakBps: bps,
            startPrice: price,
            peakPrice: price,
            pegRef,
          };
        } else {
          // Continue pending
          pending.count++;
          pending.lastTs = timestamp;
          if (absBps > Math.abs(pending.peakBps)) {
            pending.peakBps = bps;
            pending.peakPrice = price;
          }
          if (pending.count >= BACKFILL_MIN_CONFIRM_POINTS) {
            promotePending();
          }
        }
      }
    } else {
      // Below threshold
      if (current) {
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        events.push(current);
        current = null;
      }
      // Discard pending — recovered before confirmation
      pending = null;
    }
  }

  // Close any remaining active event
  if (current) {
    const lastTs = prices[prices.length - 1].timestamp;
    const now = Math.floor(Date.now() / 1000);
    if (now - lastTs > 7 * 86400) {
      current.endedAt = lastTs;
    }
    events.push(current);
  }
  // Discard any unconfirmed pending at end of series

  return events;
}
