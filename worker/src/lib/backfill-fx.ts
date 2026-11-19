import { logWorkerEventArgs } from "./structured-log";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { COMMODITY_MEDIAN_EXCLUDES } from "@shared/lib/peg-rates";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { findCommodityPeerMedian, type CommodityMedianSource, type CommodityPeg } from "@shared/lib/commodity-median";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { isTargetFixingDay } from "@shared/lib/reference-market-hours";
import type { StablecoinData } from "@shared/types/supply";
import type { ReferenceContributor } from "@shared/types/reference-admission";
import type { FxReferenceEvidence } from "@shared/types/fx-reference";
import { loadStablecoinsCache } from "./stablecoins-cache";
import type { HistoricalReferenceLookup } from "@shared/types/peg";
import {
  enumerateDates,
  findAsOfSnapshot,
  type TimestampedRatePoint,
} from "@shared/lib/rate-series";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry";
import { getCache } from "./db-cache";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { FrankfurterTimeSeriesSchema, SecondaryFxResponseSchema } from "./external-api-schemas";
import { rethrowIfAborted } from "./abort";
import { mapWithConcurrency } from "./concurrency";
import { decodeJsonString } from "./cache-json";
import { sanitizeFxRates } from "./fx-rate-state";
import {
  PRIMARY_CURRENCY_TO_PEG,
  PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS,
  SECONDARY_FX_CURRENCY_TO_PEG,
  SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS,
} from "./fx-config";
import type { D1Database } from "@cloudflare/workers-types";
import { fetchCgPriceHistoryHourly, type HistoricalMarketBackfillRange } from "./historical-market-prices";

function isValidSecondaryFxCacheDate(date: string, prefix: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(prefix)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

type SecondaryFxCache = Record<string, Record<string, number> | null>;

/** Keep dated entries whose date starts with `prefix` ("YYYY-" or "YYYY-MM-"). */
function normalizeSecondaryFxCache(
  parsed: unknown,
  prefix: string,
): SecondaryFxCache {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const normalized: SecondaryFxCache = {};
  for (const [date, rawRates] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidSecondaryFxCacheDate(date, prefix)) continue;
    if (rawRates === null) {
      normalized[date] = null;
      continue;
    }
    if (!rawRates || typeof rawRates !== "object" || Array.isArray(rawRates)) continue;

    const rawRateKeys = Object.keys(rawRates);
    if (rawRateKeys.length === 0) {
      normalized[date] = {};
      continue;
    }
    const rates = sanitizeFxRates(rawRates);
    if (Object.keys(rates).length > 0) normalized[date] = rates;
  }
  return normalized;
}

/** "YYYY-MM" of the following UTC month. */
const nextUtcMonth = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1)).toISOString().slice(0, 7);
/** "YYYY-MM-DD" of the period's last UTC day. */
const lastUtcDayOfMonth = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

const SECONDARY_FX_FETCH_CONCURRENCY = 6;
const COMMODITY_MEDIAN_FETCH_CONCURRENCY = 6;
const SECONDARY_FX_PUBLICATION_GRACE_SEC = 7 * DAY_SECONDS;
export const HISTORICAL_INTRADAY_PAIRING_SEC = 2 * HOUR_SECONDS;

function isRecentSecondaryFxDate(date: string): boolean {
  return Date.now() / 1000 - Date.parse(`${date}T00:00:00Z`) / 1000 < SECONDARY_FX_PUBLICATION_GRACE_SEC;
}

function invertCurrencyToPegMap(
  currencyToPeg: Readonly<Record<string, string>>,
  pegTypeToCurrencyPairs: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const pegCurrencyByType: Record<string, string> = Object.fromEntries(pegTypeToCurrencyPairs);
  return Object.fromEntries(
    Object.entries(currencyToPeg).map(([currency, pegType]) => {
      const pegCurrency = pegCurrencyByType[pegType];
      if (!pegCurrency) {
        throw new Error(`Missing backfill currency pair for ${pegType}`);
      }
      return [pegCurrency, currency.toUpperCase()];
    }),
  );
}

/** Maps registry pegCurrency → frankfurter currency code (ECB-published). */
export const PEG_TO_FX: Record<string, string> = invertCurrencyToPegMap(
  PRIMARY_CURRENCY_TO_PEG,
  PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS,
);

/** Maps registry pegCurrency → secondary currency-api code for non-ECB historical FX. */
export const SECONDARY_PEG_TO_FX: Record<string, string> = invertCurrencyToPegMap(
  SECONDARY_FX_CURRENCY_TO_PEG,
  SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS,
);

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
 * On failure, returns {} so callers can preserve existing history.
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
      logWorkerEventArgs("lib", "error", `[backfill-depegs] Frankfurter API returned ${fetchResult?.response.status ?? "no response"}`);
      return {};
    }
    const raw = fetchResult.body;
    const parsed = FrankfurterTimeSeriesSchema.safeParse(raw);
    if (!parsed.success) {
      logWorkerEventArgs("lib", "warn", "[backfill-depegs] Frankfurter validation failed:", parsed.error.message);
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
    logWorkerEventArgs("lib", "error", `[backfill-depegs] FX fetch failed:`, err);
    return {};
  }
}

type HistoricalSecondaryFxDayOutcome =
  | { kind: "rates"; rates: Record<string, number> }
  | { kind: "unavailable" }
  | { kind: "transient" };

async function fetchHistoricalSecondaryFxDay(
  date: string,
  signal?: AbortSignal,
): Promise<HistoricalSecondaryFxDayOutcome> {
  const primaryUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`;
  const fallbackUrl = `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`;

  let result = await fetchTextWithRetry(
    primaryUrl,
    { headers: { "User-Agent": USER_AGENT }, signal },
    2,
    { passthrough404: true, timeoutMs: 20_000 },
  );
  const primaryMissing = result?.response.status === 404;
  if (!result?.response.ok) {
    result = await fetchTextWithRetry(
      fallbackUrl,
      { headers: { "User-Agent": USER_AGENT }, signal },
      2,
      { passthrough404: true, timeoutMs: 20_000 },
    );
  }
  if (!result?.response.ok) {
    logWorkerEventArgs("lib", "warn", `[backfill-depegs] secondary FX API returned ${result?.response.status ?? "no response"} for ${date}`);
    return primaryMissing && result?.response.status === 404 && !isRecentSecondaryFxDate(date)
      ? { kind: "unavailable" } : { kind: "transient" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.body) as unknown;
  } catch (err) {
    rethrowIfAborted(err, signal);
    logWorkerEventArgs("lib", "warn", `[backfill-depegs] secondary FX returned non-JSON for ${date}`, err);
    return { kind: "transient" };
  }
  const parsed = SecondaryFxResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logWorkerEventArgs("lib", "warn", `[backfill-depegs] secondary FX validation failed for ${date}: ${parsed.error.message}`);
    return { kind: "transient" };
  }
  if (parsed.data.date != null && parsed.data.date !== date) return { kind: "transient" };
  const rates = sanitizeFxRates(parsed.data.usd);
  return Object.keys(rates).length > 0
    ? { kind: "rates", rates }
    : { kind: "transient" };
}

export async function fetchHistoricalSecondaryFxRates(
  db: D1Database,
  currencies: string[],
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
  dryRun = false,
): Promise<Record<string, FxTimeSeries[]>> {
  if (currencies.length === 0) return {};

  const normalized = Array.from(new Set(currencies.map((currency) => currency.toUpperCase())));
  const result: Record<string, FxTimeSeries[]> = Object.fromEntries(
    normalized.map((currency) => [currency, []]),
  );

  const decodeCache = (value: string, prefix: string) => decodeJsonString<SecondaryFxCache, "json-parse-failed">(
    value,
    { parseErrorReason: "json-parse-failed", normalize: (parsed) => ({ ok: true, payload: normalizeSecondaryFxCache(parsed, prefix) }) },
  );
  const legacyYearCaches = new Map<string, SecondaryFxCache>();

  // One cache row per month: a year of all-currency quotes, bound twice by the
  // compare-and-swap below, outgrew the operator CLI's 1 MiB argv limit (E2BIG).
  for (let period = startDate.slice(0, 7); period <= endDate.slice(0, 7); period = nextUtcMonth(period)) {
    const periodStart = `${period}-01`;
    const periodEnd = lastUtcDayOfMonth(period);
    const rangeStart = startDate > periodStart ? startDate : periodStart;
    const rangeEnd = endDate < periodEnd ? endDate : periodEnd;
    const wantedDates = enumerateDates(rangeStart, rangeEnd);

    const cacheKey = `fx-history-secondary:${period}`;
    let monthCache: SecondaryFxCache = {};
    let cacheChanged = false;
    let cached = await getCache(db, cacheKey, signal);
    if (cached) {
      const decoded = decodeCache(cached.value, `${period}-`);
      if (decoded.ok) {
        monthCache = decoded.payload;
        cacheChanged = JSON.stringify(monthCache) !== cached.value;
      } else {
        cacheChanged = true;
      }
    } else {
      // Carry dated evidence forward from the retired per-year row instead of refetching it.
      const year = period.slice(0, 4);
      if (!legacyYearCaches.has(year)) {
        const legacy = await getCache(db, `fx-history-secondary:${year}`, signal);
        const decoded = legacy ? decodeCache(legacy.value, `${year}-`) : null;
        legacyYearCaches.set(year, decoded?.ok ? decoded.payload : {});
      }
      for (const [date, rates] of Object.entries(legacyYearCaches.get(year)!)) {
        if (!date.startsWith(`${period}-`)) continue;
        monthCache[date] = rates ?? {};
        cacheChanged = true;
      }
    }

    const missingDates = wantedDates.filter((date) => {
      const cachedRates = monthCache[date];
      // Null is a confirmed post-grace miss. Unversioned empty maps are provisional.
      return cachedRates !== null && (!cachedRates ||
        normalized.some((currency) => cachedRates[currency.toLowerCase()] == null));
    });
    for (let i = 0; i < missingDates.length; i += SECONDARY_FX_FETCH_CONCURRENCY) {
      const chunk = missingDates.slice(i, i + SECONDARY_FX_FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        chunk.map(async (date) => [date, await fetchHistoricalSecondaryFxDay(date, signal)] as const),
      );
      for (const [date, outcome] of fetched) {
        if (outcome.kind === "rates") {
          monthCache[date] = { ...monthCache[date], ...outcome.rates };
          cacheChanged = true;
        } else if (outcome.kind === "unavailable" && !isRecentSecondaryFxDate(date)) {
          // A later unavailable response must not erase dated evidence already read.
          if (Object.keys(monthCache[date] ?? {}).length === 0) {
            monthCache[date] = null;
            cacheChanged = true;
          }
        }
      }
    }

    while (cacheChanged && !dryRun) {
      const write = await runWithOverloadRetry(() => db.prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE cache.value = ? AND cache.updated_at = ?`,
      ).bind(cacheKey, JSON.stringify(monthCache), Math.floor(Date.now() / 1000),
        cached?.value ?? null, cached?.updatedAt ?? null).run(), 3, signal);
      if (write.meta.changes === 1) break;

      // Another backfill won; retain its evidence before retrying the inspected-row fence.
      cached = await getCache(db, cacheKey, signal);
      if (!cached) continue;
      const decoded = decodeCache(cached.value, `${period}-`);
      if (decoded.ok) {
        for (const [date, rates] of Object.entries(decoded.payload)) {
          const local = monthCache[date];
          if (rates != null && Object.keys(rates).length > 0) {
            monthCache[date] = { ...local, ...rates };
          } else if (local === undefined || local != null && Object.keys(local).length === 0 && rates === null) {
            monthCache[date] = rates;
          }
        }
      }
    }

    for (const date of wantedDates) {
      const dailyRates = monthCache[date];
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

export type HistoricalCommoditySources = Partial<Record<CommodityPeg, CommodityMedianSource[]>>;
export type ReplayHistoricalReferenceLookup = {
  referenceAt(
    peg: Parameters<HistoricalReferenceLookup["referenceAt"]>[0],
    atSec: number,
    subjectId?: string,
  ): (NonNullable<ReturnType<HistoricalReferenceLookup["referenceAt"]>> & {
    contributorEvidence?: readonly ReferenceContributor[];
    observation?: FxReferenceEvidence;
  }) | null;
  entitlementAt?(assetId: string, quoteAt: number): StablecoinData["commodityEntitlement"];
};

export function hasHistoricalCommodityWeight(meta: { id: string; commodityOunces?: number }): meta is { id: string; commodityOunces: number } {
  return meta.id !== "xagm-matrixdock" && meta.commodityOunces != null && meta.commodityOunces > 0;
}

export async function fetchHistoricalCommodityPeers(
  range?: HistoricalMarketBackfillRange,
  coingeckoApiKey: string | null = null,
  pegs: readonly CommodityPeg[] = ["GOLD", "SILVER"],
  db?: D1Database,
): Promise<HistoricalCommoditySources> {
  const pegSet = new Set<string>(pegs);
  // Reserve composition history keeps hashes only. Use a retained accepted quote receipt when its exact clock matches.
  let xagmEntitlement: StablecoinData["commodityEntitlement"];
  if (db && pegSet.has("SILVER")) {
    const cache = await loadStablecoinsCache(db, { mode: "strict" });
    if (cache.kind === "ok") {
      const row = cache.payload.peggedAssets.find(({ id }) => id === "xagm-matrixdock");
      const receipt = row?.commodityEntitlement;
      if (receipt?.source === "matrixdock-frs" && /^ethereum:[1-9]\d*$/.test(receipt.generation ?? "") &&
        receipt.quoteObservedAtSec != null && receipt.quoteObservedAtSec === row?.priceObservedAt &&
        receipt.quoteObservedAtSec >= (range?.startSec ?? 0) && receipt.quoteObservedAtSec <= (range?.endSec ?? Infinity)) {
        xagmEntitlement = receipt;
      }
    }
  }
  const allCommodityCoins = ACTIVE_STABLECOINS.filter(
    (m) => pegSet.has(m.flags.pegCurrency) && isCommodityPeg(m.flags.pegCurrency) && !m.flags.navToken
      && !COMMODITY_MEDIAN_EXCLUDES.has(m.id) && (hasHistoricalCommodityWeight(m) || (m.id === "xagm-matrixdock" && xagmEntitlement)),
  );
  const sources: HistoricalCommoditySources = {};
  const fetched = await mapWithConcurrency(allCommodityCoins, COMMODITY_MEDIAN_FETCH_CONCURRENCY, async (meta) => {
    const geckoId = TRACKED_META_BY_ID.get(meta.id)?.geckoId;
    if (!geckoId) return null;
    const prices = await fetchCgPriceHistoryHourly(geckoId, range, "usd", coingeckoApiKey, undefined, true);
    return {
      peg: meta.flags.pegCurrency as CommodityPeg,
      assetId: meta.id,
      sourceId: `coingecko:${geckoId}`,
      commodityOunces: meta.commodityOunces,
      prices: meta.id === "xagm-matrixdock" ? prices.flatMap((point) =>
        point.timestamp === xagmEntitlement?.quoteObservedAtSec ? [{ ...point, commodityEntitlement: xagmEntitlement }] : []) : prices,
    };
  });
  for (const source of fetched) {
    if (source) (sources[source.peg] ??= []).push(source);
  }
  return sources;
}

export function buildHistoricalReferenceLookup(opts: {
  subjectId?: string;
  commodityPeers?: HistoricalCommoditySources;
  commoditySpot?: Partial<Record<CommodityPeg, { source: string; prices: readonly (FxTimeSeries & { observation?: FxReferenceEvidence })[] }>>;
}): ReplayHistoricalReferenceLookup {
  const xagm = opts.commodityPeers?.SILVER?.find((source) => source.assetId === "xagm-matrixdock");
  return {
    entitlementAt(id, quoteAt) {
      if (id !== "xagm-matrixdock") return undefined;
      return findAsOfSnapshot(xagm?.prices, quoteAt, (point) => point.timestamp, 0)?.commodityEntitlement;
    },
    referenceAt(peg, atSec, subjectId = opts.subjectId) {
      if (!Number.isSafeInteger(atSec) || atSec <= 0) return null;
      if (peg === "GOLD" || peg === "SILVER") {
        const spot = opts.commoditySpot?.[peg];
        const quote = findAsOfSnapshot(spot?.prices, atSec, (entry) => entry.timestamp, HISTORICAL_INTRADAY_PAIRING_SEC);
        if (spot && quote && Number.isFinite(quote.rate) && quote.rate > 0) {
          return { usdPerUnit: quote.rate, observedAtSec: quote.timestamp, source: spot.source, kind: "fallback",
            ...(quote.observation ? { observation: quote.observation } : {}) };
        }
        if (!subjectId) return null;
        const peers = findCommodityPeerMedian(opts.commodityPeers?.[peg] ?? [], subjectId, atSec, HISTORICAL_INTRADAY_PAIRING_SEC);
        return peers ? { ...peers, source: "peer-median", kind: "median" } : null;
      }
      return null;
    },
  };
}

/** UTC fixing labels support bounded valuation without supplying an observation clock. */
export function findHistoricalFxValuationRate(
  series: Readonly<Record<string, readonly FxTimeSeries[]>>,
  peg: Parameters<HistoricalReferenceLookup["referenceAt"]>[0],
  subjectId: string,
  atSec: number,
): number | null {
  const secondary = SECONDARY_PEG_TO_FX[peg];
  const code = PEG_TO_FX[peg] ?? secondary ?? (peg === "OTHER" ? OTHER_COIN_FX[subjectId] : undefined);
  if (!code) return null;
  const day = findAsOfSnapshot(series[code], atSec - DAY_SECONDS, (entry) => entry.timestamp, DAY_SECONDS - 1);
  return day && Number.isFinite(day.rate) && day.rate > 0 && (secondary || isTargetFixingDay(day.timestamp))
    ? day.rate : null;
}
