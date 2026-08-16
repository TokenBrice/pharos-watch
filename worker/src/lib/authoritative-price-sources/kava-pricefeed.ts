import { logWorkerEventArgs } from "../structured-log";
import { z } from "zod";
import { median } from "@shared/lib/stats";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE, USER_AGENT } from "../constants";
import { fetchJsonWithRetry } from "../fetch-retry";
import type { CurrentPriceOverride, LivePriceContext, PriceSourceProvider } from "./helpers";

const KAVA_API_BASE = "https://api.data.kava.io";
const KAVA_CHAIN_ID = "kava_2222-10";
const KAVA_USDX_ID = "usdx-kava";
const KAVA_USDX_MARKET_ID = "usdx:usd";
const KAVA_PRICEFEED_SOURCE = "kava-pricefeed";

const KAVA_REQUEST_TIMEOUT_MS = 2_200;
const KAVA_MAX_RESPONSE_BYTES = 256 * 1024;
const KAVA_BLOCK_MAX_AGE_SEC = 2 * 60;
const KAVA_BLOCK_MAX_FUTURE_SKEW_SEC = 60;
const KAVA_CACHE_TRUST_WINDOW_SEC = 30 * 60;
const KAVA_MAX_ORACLE_DISPERSION_BPS = 2_000;
const KAVA_MAX_AGGREGATE_MEDIAN_DEVIATION_BPS = 1_000;

const KavaBlockSchema = z.object({
  block: z.object({
    header: z.object({
      chain_id: z.string(),
      height: z.string(),
      time: z.string(),
    }),
  }),
});

const KavaMarketsSchema = z.object({
  markets: z.array(
    z.object({
      market_id: z.string(),
      base_asset: z.string(),
      quote_asset: z.string(),
      oracles: z.array(z.string()),
      active: z.boolean(),
    }),
  ),
});

const KavaAggregatePriceSchema = z.object({
  price: z.object({
    market_id: z.string(),
    price: z.string(),
  }),
});

const KavaRawPricesSchema = z.object({
  raw_prices: z.array(
    z.object({
      market_id: z.string(),
      oracle_address: z.string(),
      price: z.string(),
      expiry: z.string(),
    }),
  ),
});

interface KavaUsdxPriceResult {
  price: number;
  observedAt: number;
  blockHeight: number;
  activeOracleCount: number;
  newestExpiry: number;
  dispersionBps: number;
}

function parseFinitePositiveDecimal(value: string): number | null {
  const characters = [...value];
  let decimalPoints = 0;
  if (
    characters.length === 0 ||
    characters.length > 128 ||
    characters[0] === "." ||
    characters[characters.length - 1] === "." ||
    characters.some((character) => {
      if (character === ".") {
        decimalPoints += 1;
        return decimalPoints > 1;
      }
      return character < "0" || character > "9";
    })
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTimestampSec(value: string): number | null {
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) && parsedMs > 0 ? Math.floor(parsedMs / 1_000) : null;
}

async function fetchKavaJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  const result = await fetchJsonWithRetry<unknown>(
    url,
    {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    0,
    {
      timeoutMs: KAVA_REQUEST_TIMEOUT_MS,
      maxResponseBytes: KAVA_MAX_RESPONSE_BYTES,
    },
  );
  if (!result?.response.ok) {
    logWorkerEventArgs("lib", "warn", `[kava-pricefeed] request failed with status ${result?.response.status ?? "no response"}`);
    return null;
  }
  return result.body;
}

export async function fetchKavaUsdxPrice(signal?: AbortSignal): Promise<KavaUsdxPriceResult | null> {
  const nowSec = Math.floor(Date.now() / 1_000);

  // Keep these reads serial: each response body is consumed before the next
  // request opens, preserving the cron trigger's shared connection budget.
  const blockPayload = await fetchKavaJson(`${KAVA_API_BASE}/cosmos/base/tendermint/v1beta1/blocks/latest`, signal);
  const blockResult = KavaBlockSchema.safeParse(blockPayload);
  if (!blockResult.success) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] latest block response failed schema validation");
    return null;
  }

  const { header } = blockResult.data.block;
  const blockHeight = Number(header.height);
  const blockTime = parseTimestampSec(header.time);
  if (
    header.chain_id !== KAVA_CHAIN_ID ||
    !Number.isSafeInteger(blockHeight) ||
    blockHeight <= 0 ||
    blockTime == null ||
    nowSec - blockTime > KAVA_BLOCK_MAX_AGE_SEC ||
    blockTime - nowSec > KAVA_BLOCK_MAX_FUTURE_SKEW_SEC
  ) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] latest block identity or freshness validation failed");
    return null;
  }

  const marketsPayload = await fetchKavaJson(`${KAVA_API_BASE}/kava/pricefeed/v1beta1/markets`, signal);
  const marketsResult = KavaMarketsSchema.safeParse(marketsPayload);
  if (!marketsResult.success) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] markets response failed schema validation");
    return null;
  }

  const matchingMarkets = marketsResult.data.markets.filter((market) => market.market_id === KAVA_USDX_MARKET_ID);
  const market = matchingMarkets.length === 1 ? matchingMarkets[0] : null;
  if (!market?.active || market.base_asset !== "usdx" || market.quote_asset !== "usd" || market.oracles.length === 0) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX market identity or active-oracle validation failed");
    return null;
  }
  const authorizedOracles = new Set(market.oracles);

  const aggregatePayload = await fetchKavaJson(
    `${KAVA_API_BASE}/kava/pricefeed/v1beta1/prices/${KAVA_USDX_MARKET_ID}`,
    signal,
  );
  const aggregateResult = KavaAggregatePriceSchema.safeParse(aggregatePayload);
  if (!aggregateResult.success || aggregateResult.data.price.market_id !== KAVA_USDX_MARKET_ID) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX aggregate response failed schema or market validation");
    return null;
  }
  const aggregatePrice = parseFinitePositiveDecimal(aggregateResult.data.price.price);
  if (aggregatePrice == null) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX aggregate price is not finite and positive");
    return null;
  }

  const rawPayload = await fetchKavaJson(
    `${KAVA_API_BASE}/kava/pricefeed/v1beta1/rawprices/${KAVA_USDX_MARKET_ID}`,
    signal,
  );
  const rawResult = KavaRawPricesSchema.safeParse(rawPayload);
  if (!rawResult.success || rawResult.data.raw_prices.some((entry) => entry.market_id !== KAVA_USDX_MARKET_ID)) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX raw-price response failed schema or market validation");
    return null;
  }

  const activeRawPrices = rawResult.data.raw_prices.flatMap((entry) => {
    const price = parseFinitePositiveDecimal(entry.price);
    const expiry = parseTimestampSec(entry.expiry);
    if (
      !authorizedOracles.has(entry.oracle_address) ||
      price == null ||
      expiry == null ||
      expiry < nowSec + KAVA_CACHE_TRUST_WINDOW_SEC
    ) {
      return [];
    }
    return [{ price, expiry }];
  });
  if (activeRawPrices.length === 0) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX has no authorized raw oracle valid through the cache trust window");
    return null;
  }

  const oraclePrices = activeRawPrices.map((entry) => entry.price);
  const oracleMedian = median(oraclePrices);
  if (oracleMedian == null || oracleMedian <= 0) return null;
  const oracleMin = Math.min(...oraclePrices);
  const oracleMax = Math.max(...oraclePrices);
  const dispersionBps = Math.round(((oracleMax - oracleMin) / oracleMedian) * 10_000);
  const aggregateDeviationBps = Math.round((Math.abs(aggregatePrice - oracleMedian) / oracleMedian) * 10_000);
  if (
    dispersionBps > KAVA_MAX_ORACLE_DISPERSION_BPS ||
    aggregateDeviationBps > KAVA_MAX_AGGREGATE_MEDIAN_DEVIATION_BPS
  ) {
    logWorkerEventArgs("lib", "warn", "[kava-pricefeed] USDX aggregate and active raw oracles do not agree within bounds");
    return null;
  }

  return {
    price: aggregatePrice,
    observedAt: blockTime,
    blockHeight,
    activeOracleCount: activeRawPrices.length,
    newestExpiry: Math.max(...activeRawPrices.map((entry) => entry.expiry)),
    dispersionBps,
  };
}

export const kavaUsdxPricefeedProvider: PriceSourceProvider = {
  source: KAVA_PRICEFEED_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.KAVA_PRICEFEED,
  livePriority: 1,
  liveTimeoutMs: 3_000,
  recordNullLiveResultAsCircuitFailure: true,
  matches(stablecoinId: string): boolean {
    return stablecoinId === KAVA_USDX_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    _context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const result = await fetchKavaUsdxPrice(signal);
    if (!result) return null;

    return {
      price: result.price,
      source: KAVA_PRICEFEED_SOURCE,
      confidence: "high",
      observedAt: result.observedAt,
      observedAtMode: "upstream",
      metadata: {
        kavaPricefeed: {
          marketId: KAVA_USDX_MARKET_ID,
          blockHeight: result.blockHeight,
          activeOracleCount: result.activeOracleCount,
          newestExpiry: result.newestExpiry,
          dispersionBps: result.dispersionBps,
        },
      },
    };
  },
};
