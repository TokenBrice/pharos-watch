import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { StablecoinMeta } from "@shared/types/core";
import { DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { cgHeaders, cgUrl } from "../lib/coingecko";
import { CoinGeckoMarketChartSchema } from "../lib/external-api-schemas";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import { getNativePegQueryCurrencies } from "../lib/native-peg-quotes";
import { RATE_LIMITS } from "../lib/rate-limit";
import { rethrowIfAborted, sleepWithSignal } from "../lib/abort";

export interface PricePoint {
  timestamp: number;
  price: number;
}

export type HistoricalMarketSource = "coingecko" | "coingecko-native" | "defillama";
export type HistoricalMarketBackfillGranularity = "daily" | "hourly";
export interface HistoricalMarketBackfillRange {
  startSec?: number | null;
  endSec?: number | null;
}
export type HistoricalMarketMergeReason =
  | "coingecko-empty"
  | "coingecko-tail-stale"
  | "coingecko-recent-sparse"
  | "coingecko-span-sparse";

export interface HistoricalMarketSeriesStats {
  source: HistoricalMarketSource;
  points: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
}

export interface HistoricalMarketPolicyAdjustment {
  source: HistoricalMarketSource;
  adjustment: "above-peg-clamp";
  removedPoints: number;
}

export interface HistoricalMarketSourceDiagnostics {
  granularity: HistoricalMarketBackfillGranularity;
  sourcesUsed: HistoricalMarketSource[];
  quoteMode: "usd" | "native-peg";
  quoteCurrency: string;
  mergeReasons: HistoricalMarketMergeReason[];
  perSourceStats: HistoricalMarketSeriesStats[];
  policyAdjustments: HistoricalMarketPolicyAdjustment[];
  finalPointCount: number;
}

export interface HistoricalMarketPriceSeriesResult {
  prices: PricePoint[] | null;
  diagnostics: HistoricalMarketSourceDiagnostics;
}

interface HistoricalMarketQuoteOptions {
  pegCurrency?: string | null;
  useNativePegQuote?: boolean;
}

interface HistoricalSourcePolicy {
  coinGecko?: {
    abovePegExclusions?: Array<{
      from: number;
      to: number;
      maxPrice: number;
    }>;
  };
}

const HISTORICAL_SOURCE_POLICIES: Record<string, HistoricalSourcePolicy> = {
  "usdt-tether": {
    coinGecko: {
      abovePegExclusions: [
        { from: 1_531_000_000, to: 1_534_000_000, maxPrice: 1.02 },
      ],
    },
  },
};

function buildSeriesStats(
  source: HistoricalMarketSource,
  prices: PricePoint[],
): HistoricalMarketSeriesStats {
  return {
    source,
    points: prices.length,
    startTimestamp: prices[0]?.timestamp ?? null,
    endTimestamp: prices[prices.length - 1]?.timestamp ?? null,
  };
}

function dedupeAndSortPrices(prices: PricePoint[]): PricePoint[] {
  const byTimestamp = new Map<number, number>();
  for (const point of prices) {
    if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.price) || point.price <= 0) continue;
    byTimestamp.set(point.timestamp, point.price);
  }
  return [...byTimestamp.entries()]
    .map(([timestamp, price]) => ({ timestamp, price }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function appendUniqueSources(
  target: HistoricalMarketSource[],
  source: HistoricalMarketSource,
): void {
  if (!target.includes(source)) {
    target.push(source);
  }
}

function appendUniqueMergeReason(
  target: HistoricalMarketMergeReason[],
  reason: HistoricalMarketMergeReason,
): void {
  if (!target.includes(reason)) {
    target.push(reason);
  }
}

function applyHistoricalPolicyAdjustments(
  stablecoinId: string,
  prices: PricePoint[],
): { prices: PricePoint[]; adjustments: HistoricalMarketPolicyAdjustment[] } {
  const policy = HISTORICAL_SOURCE_POLICIES[stablecoinId];
  if (!policy?.coinGecko?.abovePegExclusions?.length) {
    return { prices, adjustments: [] };
  }

  let filtered = prices;
  const adjustments: HistoricalMarketPolicyAdjustment[] = [];

  for (const exclusion of policy.coinGecko.abovePegExclusions) {
    const before = filtered.length;
    filtered = filtered.filter((point) => !(
      point.timestamp >= exclusion.from &&
      point.timestamp <= exclusion.to &&
      point.price > exclusion.maxPrice
    ));
    const removedPoints = before - filtered.length;
    if (removedPoints > 0) {
      adjustments.push({
        source: "coingecko",
        adjustment: "above-peg-clamp",
        removedPoints,
      });
    }
  }

  return { prices: filtered, adjustments };
}

function isTailStale(
  prices: PricePoint[],
  granularity: HistoricalMarketBackfillGranularity,
): boolean {
  if (prices.length === 0) return true;
  const latestTimestamp = prices[prices.length - 1]!.timestamp;
  const maxAgeSec = granularity === "hourly" ? 3 * DAY_SECONDS : 14 * DAY_SECONDS;
  return Math.floor(Date.now() / 1000) - latestTimestamp > maxAgeSec;
}

function isRecentCoverageSparse(
  prices: PricePoint[],
  granularity: HistoricalMarketBackfillGranularity,
): boolean {
  if (prices.length === 0) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = granularity === "hourly" ? 7 * DAY_SECONDS : 60 * DAY_SECONDS;
  const threshold = granularity === "hourly" ? 24 : 14;
  const recentPoints = prices.filter((point) => nowSec - point.timestamp <= windowSec);
  return recentPoints.length > 0 && recentPoints.length < threshold;
}

function isSpanCoverageSparse(
  prices: PricePoint[],
  granularity: HistoricalMarketBackfillGranularity,
): boolean {
  if (prices.length < 2) return prices.length === 0;
  const spanSec = prices[prices.length - 1]!.timestamp - prices[0]!.timestamp;
  if (spanSec <= 0) return false;
  const spanDays = spanSec / DAY_SECONDS;
  const density = prices.length / Math.max(spanDays, 1);
  return granularity === "hourly" ? density < 2 : density < 0.2;
}

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

async function fetchCgPriceHistoryDaily(
  geckoId: string,
  range?: HistoricalMarketBackfillRange,
  vsCurrency = "usd",
  coingeckoApiKey: string | null = null,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  try {
    const startSec = range?.startSec ?? null;
    const endSec = range?.endSec ?? Math.floor(Date.now() / 1000);
    const path =
      startSec != null
        ? `/coins/${geckoId}/market_chart/range?vs_currency=${vsCurrency}&from=${startSec}&to=${endSec}&precision=full`
        : `/coins/${geckoId}/market_chart?vs_currency=${vsCurrency}&days=max`;
    const result = await fetchJsonWithRetry(
      cgUrl(path, coingeckoApiKey),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey), signal },
      2,
      { timeoutMs: 30_000 },
    );
    if (!result) return [];
    const parsed = CoinGeckoMarketChartSchema.safeParse(result.body);
    if (!parsed.success) {
      console.warn("[backfill-pricing] CG market chart validation failed:", parsed.error.message);
      return [];
    }
    return parsed.data.prices
      .filter(([, price]) => price > 0)
      .map(([timestampMs, price]) => ({ timestamp: Math.floor(timestampMs / 1000), price }));
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.error(`[backfill-pricing] Failed to fetch CG daily price history for ${geckoId}/${vsCurrency}:`, err);
    return [];
  }
}

export async function fetchCgPriceHistoryHourly(
  geckoId: string,
  range?: HistoricalMarketBackfillRange,
  vsCurrency = "usd",
  coingeckoApiKey: string | null = null,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  const seen = new Map<number, number>();
  const HOURLY_EPOCH = Math.floor(new Date("2018-01-30T00:00:00Z").getTime() / 1000);
  const CHUNK_DAYS = 89;
  const CHUNK_SEC = CHUNK_DAYS * DAY_SECONDS;
  const startSec = Math.max(0, range?.startSec ?? Math.floor(new Date("2014-01-01T00:00:00Z").getTime() / 1000));
  const endSec = range?.endSec ?? Math.floor(Date.now() / 1000);

  if (startSec >= endSec) {
    return [];
  }

  try {
    if (startSec < HOURLY_EPOCH) {
      await sleepWithSignal(RATE_LIMITS.COINGECKO_BACKFILL_MS, signal);
      const phaseOne = await fetchJsonWithRetry(
        cgUrl(
          `/coins/${geckoId}/market_chart/range?vs_currency=${vsCurrency}&from=${startSec}&to=${Math.min(endSec, HOURLY_EPOCH)}&precision=full`,
          coingeckoApiKey,
        ),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey), signal },
        2,
        { timeoutMs: 30_000 },
      );
      if (phaseOne) {
        const parsed = CoinGeckoMarketChartSchema.safeParse(phaseOne.body);
        if (parsed.success) {
          for (const [timestampMs, price] of parsed.data.prices) {
            if (price > 0) {
              seen.set(Math.floor(timestampMs / 1000), price);
            }
          }
        }
      }
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.error(`[backfill-pricing] CG hourly phase-1 failed for ${geckoId}:`, err);
  }

  for (let chunkFrom = Math.max(HOURLY_EPOCH, startSec); chunkFrom < endSec; chunkFrom += CHUNK_SEC) {
    const chunkTo = Math.min(chunkFrom + CHUNK_SEC, endSec);
    try {
      await sleepWithSignal(RATE_LIMITS.COINGECKO_BACKFILL_MS, signal);
      const result = await fetchJsonWithRetry(
        cgUrl(
          `/coins/${geckoId}/market_chart/range?vs_currency=${vsCurrency}&from=${chunkFrom}&to=${chunkTo}&precision=full`,
          coingeckoApiKey,
        ),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey), signal },
        2,
        { timeoutMs: 30_000 },
      );
      if (!result) continue;
      const parsed = CoinGeckoMarketChartSchema.safeParse(result.body);
      if (!parsed.success) continue;
      for (const [timestampMs, price] of parsed.data.prices) {
        if (price > 0) {
          seen.set(Math.floor(timestampMs / 1000), price);
        }
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      console.error(`[backfill-pricing] CG hourly chunk failed for ${geckoId}/${vsCurrency} (${chunkFrom}-${chunkTo}):`, err);
    }
  }

  if (seen.size === 0) {
    return fetchCgPriceHistoryDaily(geckoId, range, vsCurrency, coingeckoApiKey, signal);
  }

  return dedupeAndSortPrices(
    [...seen.entries()].map(([timestamp, price]) => ({ timestamp, price })),
  );
}

async function fetchDlPriceChart(
  coinId: string,
  start: number,
  end?: number | null,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  try {
    const normalizedEnd = end ?? Math.floor(Date.now() / 1000);
    const spanDays = Math.max(1, Math.min(800, Math.ceil((normalizedEnd - start) / DAY_SECONDS) + 1));
    const result = await fetchJsonWithRetry<{
      coins?: Record<string, { prices?: PricePoint[] }>;
    }>(
      `${DEFILLAMA_COINS}/chart/${coinId}?start=${start}&span=${spanDays}&period=1d`,
      { headers: { "User-Agent": USER_AGENT }, signal },
      1,
      { timeoutMs: 20_000 },
    );
    if (!result?.response.ok) return [];
    const data = result.body;
    return dedupeAndSortPrices(data.coins?.[coinId]?.prices ?? []);
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.error(`[backfill-pricing] DL fallback failed for ${coinId}:`, err);
    return [];
  }
}

export async function fetchMarketBackfillPriceSeries(
  meta: StablecoinMeta,
  geckoId: string,
  options?: {
    granularity?: HistoricalMarketBackfillGranularity;
    seedCoinGeckoPrices?: PricePoint[];
    range?: HistoricalMarketBackfillRange;
    quote?: HistoricalMarketQuoteOptions;
    coingeckoApiKey?: string | null;
    signal?: AbortSignal;
  },
): Promise<HistoricalMarketPriceSeriesResult> {
  const granularity = options?.granularity ?? "hourly";
  const nativeQuoteCurrencies = options?.quote?.useNativePegQuote
    ? getNativePegQueryCurrencies(options?.quote?.pegCurrency ?? meta.flags.pegCurrency)
    : [];
  const quoteMode = nativeQuoteCurrencies.length > 0 ? "native-peg" : "usd";
  let quoteCurrency = nativeQuoteCurrencies[0] ?? "usd";
  const primarySource: HistoricalMarketSource = quoteMode === "native-peg" ? "coingecko-native" : "coingecko";
  const diagnostics: HistoricalMarketSourceDiagnostics = {
    granularity,
    quoteMode,
    quoteCurrency,
    sourcesUsed: [],
    mergeReasons: [],
    perSourceStats: [],
    policyAdjustments: [],
    finalPointCount: 0,
  };

  let rawCgPrices = options?.seedCoinGeckoPrices ?? null;
  if (rawCgPrices == null) {
    const quoteCurrencyCandidates = quoteMode === "native-peg" ? nativeQuoteCurrencies : ["usd"];
    for (let index = 0; index < quoteCurrencyCandidates.length; index++) {
      const candidateCurrency = quoteCurrencyCandidates[index]!;
      const candidatePrices = granularity === "daily"
        ? await fetchCgPriceHistoryDaily(geckoId, options?.range, candidateCurrency, options?.coingeckoApiKey ?? null, options?.signal)
        : await fetchCgPriceHistoryHourly(geckoId, options?.range, candidateCurrency, options?.coingeckoApiKey ?? null, options?.signal);
      if (candidatePrices.length > 0 || index === quoteCurrencyCandidates.length - 1) {
        rawCgPrices = candidatePrices;
        quoteCurrency = candidateCurrency;
        diagnostics.quoteCurrency = candidateCurrency;
        break;
      }
    }
  }
  const cgAdjusted = applyHistoricalPolicyAdjustments(meta.id, dedupeAndSortPrices(rawCgPrices ?? []));
  const cgPrices = cgAdjusted.prices;
  diagnostics.policyAdjustments.push(...cgAdjusted.adjustments);
  diagnostics.perSourceStats.push(buildSeriesStats(primarySource, cgPrices));

  let mergedPrices = cgPrices;
  let shouldMergeDefiLlama = false;
  if (quoteMode === "usd" && cgPrices.length === 0) {
    appendUniqueMergeReason(diagnostics.mergeReasons, "coingecko-empty");
    shouldMergeDefiLlama = true;
  } else if (quoteMode === "usd") {
    if (isTailStale(cgPrices, granularity)) {
      appendUniqueMergeReason(diagnostics.mergeReasons, "coingecko-tail-stale");
      shouldMergeDefiLlama = true;
    }
    if (isRecentCoverageSparse(cgPrices, granularity)) {
      appendUniqueMergeReason(diagnostics.mergeReasons, "coingecko-recent-sparse");
      shouldMergeDefiLlama = true;
    }
    if (isSpanCoverageSparse(cgPrices, granularity)) {
      appendUniqueMergeReason(diagnostics.mergeReasons, "coingecko-span-sparse");
      shouldMergeDefiLlama = true;
    }
  }

  if (shouldMergeDefiLlama) {
    const coinId = `coingecko:${geckoId}`;
    const twoYearsAgo = Math.floor(Date.now() / 1000) - (2 * 365 * DAY_SECONDS);
    const fourYearsAgo = twoYearsAgo - (2 * 365 * DAY_SECONDS);
    const rangeStart = options?.range?.startSec ?? null;
    const rangeEnd = options?.range?.endSec ?? null;
    const dlPrices = dedupeAndSortPrices([
      ...(rangeStart != null || rangeEnd != null
        ? await fetchDlPriceChart(coinId, rangeStart ?? fourYearsAgo, rangeEnd, options?.signal)
        : await fetchDlPriceChart(coinId, fourYearsAgo, null, options?.signal)),
      ...(rangeStart != null || rangeEnd != null
        ? []
        : await fetchDlPriceChart(coinId, twoYearsAgo, null, options?.signal)),
    ]);
    diagnostics.perSourceStats.push(buildSeriesStats("defillama", dlPrices));
    if (dlPrices.length > 0) {
      mergedPrices = dedupeAndSortPrices([...cgPrices, ...dlPrices]);
      appendUniqueSources(diagnostics.sourcesUsed, "defillama");
    }
  }

  if (cgPrices.length > 0) {
    appendUniqueSources(diagnostics.sourcesUsed, primarySource);
  }

  diagnostics.finalPointCount = mergedPrices.length;
  return {
    prices: mergedPrices.length > 0 ? mergedPrices : null,
    diagnostics,
  };
}
