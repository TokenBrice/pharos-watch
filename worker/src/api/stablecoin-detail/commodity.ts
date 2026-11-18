import { DEFILLAMA_API, DEFILLAMA_COINS } from "../../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { isDedicatedSingleTokenGoldProtocolSlug } from "@shared/lib/commodity-protocols";
import { fetchCoinGeckoMarketHistory } from "../../lib/coingecko-market-history";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import {
  buildNativeSupplyBuckets,
  buildPriceMapByDate,
  buildTokenRowsFromMarketCaps,
  type DetailResponseHelpers,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  extractDefiLlamaCoinChartPrices,
  findNearestPrice,
  logUpstreamFailure,
  logUpstreamException,
} from "./shared";

export interface CommodityDetailConfig {
  stablecoinId: string;
  geckoId: string;
  protocolSlug: string;
  pegType: string;
  coingeckoApiKey?: string | null;
}

/**
 * Builds chart-compatible commodity tokens from DefiLlama protocol TVL + prices,
 * with CoinGecko market_chart fallback.
 */
export async function fetchCommodityTokens(
  config: CommodityDetailConfig,
): Promise<Record<string, unknown>[]> {
  if (isKinesisWrapperSupplyCutoverActive(config.stablecoinId, Math.floor(Date.now() / 1000))) return [];
  const xaut = config.stablecoinId === "xaut-tether";
  const useProtocol = isDedicatedSingleTokenGoldProtocolSlug(config.protocolSlug);
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * DAY_SECONDS;

  const [priceResult, protocolResult] = await Promise.all([
    useProtocol ? fetchJsonWithRetry(
      `${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=${twoYearsAgo}&span=730`,
      undefined,
      DETAIL_UPSTREAM_MAX_RETRIES,
      { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
    ) : Promise.resolve(null),
    useProtocol
      ? fetchJsonWithRetry<{
          tvl?: { date: number; totalLiquidityUSD: number }[];
        }>(
          `${DEFILLAMA_API}/protocol/${config.protocolSlug}`,
          undefined,
          DETAIL_UPSTREAM_MAX_RETRIES,
          { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
        )
      : Promise.resolve(null),
  ]);

  let prices: { timestamp: number; price: number }[] = [];
  if (priceResult?.response.ok) {
    prices = extractDefiLlamaCoinChartPrices(priceResult.body, config.geckoId);
  } else if (useProtocol) {
    logUpstreamFailure(
      "defillama-coins-chart",
      config.stablecoinId,
      priceResult?.response.status ?? "no-response",
    );
  }

  let tvlHistory: { date: number; totalLiquidityUSD: number }[] = [];
  if (protocolResult?.response.ok) {
    const protocolData = protocolResult.body;
    tvlHistory = protocolData.tvl ?? [];
  } else if (useProtocol) {
    logUpstreamFailure(
      "defillama-protocol-detail",
      config.stablecoinId,
      protocolResult?.response.status ?? "no-response",
    );
  }

  // Merge TVL history with price data to produce chart-compatible tokens array.
  let tokens: Record<string, unknown>[] = [];

  if (tvlHistory.length > 0) {
    const pricesByDay = new Map<number, typeof prices>();
    for (const quote of prices) {
      if (quote.price <= 0) continue;
      const day = bucketUnixSecondsToUtcDay(quote.timestamp);
      const quotes = pricesByDay.get(day) ?? [];
      quotes.push(quote);
      pricesByDay.set(day, quotes);
    }
    tokens = tvlHistory.map((point) => {
      const price = findNearestPrice(pricesByDay.get(bucketUnixSecondsToUtcDay(point.date)) ?? [], point.date);
      const marketCap = point.totalLiquidityUSD;
      return {
        date: point.date,
        ...(xaut ? { supplySource: "defillama", supplyObservedAt: point.date } : {}),
        totalCirculatingUSD: { [config.pegType]: marketCap },
        totalCirculating: buildNativeSupplyBuckets(config.pegType, marketCap, price),
      };
    });
  }

  // Fallback: no protocol TVL → preserve day-specific CoinGecko market caps.
  if (tokens.length === 0) {
    const marketHistory = await fetchCoinGeckoMarketHistory(config.geckoId, {
      apiKey: config.coingeckoApiKey ?? null,
      retries: DETAIL_UPSTREAM_MAX_RETRIES,
      timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS,
      onCoinDetailFailure: (status) => {
        logUpstreamFailure("coingecko-coin-detail", config.stablecoinId, status);
      },
    });

    if (!marketHistory) {
      logUpstreamFailure("coingecko-market-chart", config.stablecoinId, "no-response");
      return [];
    }

    const priceMap = buildPriceMapByDate(marketHistory.prices);
    tokens = buildTokenRowsFromMarketCaps(
      marketHistory.marketCaps,
      config.pegType,
      priceMap,
    );
    if (xaut) {
      tokens = tokens.map((token) => ({ ...token, supplySource: "coingecko", supplyObservedAt: token.date }));
    }
  }

  return tokens;
}

export async function handleCommodityDetail(
  config: CommodityDetailConfig,
  detail: DetailResponseHelpers,
): Promise<Response> {
  if (isKinesisWrapperSupplyCutoverActive(config.stablecoinId, Math.floor(Date.now() / 1000))) return detail.serveWrapperHistory();
  try {
    const history = await detail.resolveTokensWithSupplyHistoryFallback(
      await fetchCommodityTokens(config),
      {
        emptyReason: "commodity-history-empty",
        staleReason: "commodity-history-stale",
      },
    );
    // An empty resolved history has no admitted provider or D1 observations: serve the
    // retained detail generation or an unavailable error, never a 200 empty body.
    if (history.tokens.length === 0) {
      return detail.staleCacheOrError(502, `Historical detail data unavailable for stablecoin ${config.stablecoinId}`);
    }
    return detail.createResponseFromResolvedTokens(history);
  } catch (err) {
    logUpstreamException("commodity-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("commodity-upstream-failure");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, "Failed to fetch commodity token data");
  }
}
