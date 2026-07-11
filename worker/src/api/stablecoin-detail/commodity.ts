import { DEFILLAMA_API, DEFILLAMA_COINS } from "../../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fetchCoinGeckoMarketHistory } from "../../lib/coingecko-market-history";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { resolveMarketCap } from "../../lib/resolve-market-cap";
import {
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
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * DAY_SECONDS;

  const [priceResult, protocolResult] = await Promise.all([
    fetchJsonWithRetry(
      `${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=${twoYearsAgo}&span=730`,
      undefined,
      DETAIL_UPSTREAM_MAX_RETRIES,
      { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
    ),
    config.protocolSlug
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
  } else {
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
  } else if (config.protocolSlug) {
    logUpstreamFailure(
      "defillama-protocol-detail",
      config.stablecoinId,
      protocolResult?.response.status ?? "no-response",
    );
  }

  // Merge TVL history with price data to produce chart-compatible tokens array.
  let tokens: Record<string, unknown>[] = [];

  if (tvlHistory.length > 0 && prices.length > 0) {
    const sortedPrices = [...prices].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    tokens = tvlHistory.map((point) => {
      const price = findNearestPrice(sortedPrices, point.date);
      const marketCap = point.totalLiquidityUSD;
      return {
        date: point.date,
        totalCirculatingUSD: { [config.pegType]: marketCap },
        totalCirculating: {
          [config.pegType]: price > 0 ? marketCap / price : 0,
        },
      };
    });
  }

  // Fallback: no protocol TVL → use CoinGecko market_chart with sanity check.
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
      (mcap, price) => (price > 0 ? resolveMarketCap(mcap, marketHistory.circulatingSupply, price) : mcap),
    );
  }

  return tokens;
}

export async function handleCommodityDetail(
  config: CommodityDetailConfig,
  detail: DetailResponseHelpers,
): Promise<Response> {
  try {
    const tokens = await detail.resolveTokensWithSupplyHistoryFallback(
      await fetchCommodityTokens(config),
      {
        emptyReason: "commodity-history-empty",
        staleReason: "commodity-history-stale",
      },
    );
    return detail.createFreshResponseFromTokens(tokens);
  } catch (err) {
    logUpstreamException("commodity-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("commodity-upstream-failure");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, "Failed to fetch commodity token data");
  }
}
