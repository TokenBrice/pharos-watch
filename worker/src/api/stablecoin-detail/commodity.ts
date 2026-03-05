import { DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { resolveMarketCap } from "../../lib/resolve-market-cap";
import {
  buildPriceMapByDate,
  buildTokenRowsFromMarketCaps,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  findNearestPrice,
  logUpstreamFailure,
} from "./shared";

export interface CommodityDetailConfig {
  stablecoinId: string;
  geckoId: string;
  protocolSlug: string;
  pegType: string;
}

/**
 * Builds chart-compatible commodity tokens from DefiLlama protocol TVL + prices,
 * with CoinGecko market_chart fallback.
 */
export async function fetchCommodityTokens(
  config: CommodityDetailConfig,
): Promise<Record<string, unknown>[]> {
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;

  const [priceRes, protocolRes] = await Promise.all([
    fetchWithRetry(
      `${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=${twoYearsAgo}&span=730`,
      undefined,
      DETAIL_UPSTREAM_MAX_RETRIES,
      { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
    ),
    config.protocolSlug
      ? fetchWithRetry(
          `${DEFILLAMA_API}/protocol/${config.protocolSlug}`,
          undefined,
          DETAIL_UPSTREAM_MAX_RETRIES,
          { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
        )
      : Promise.resolve(null),
  ]);

  let prices: { timestamp: number; price: number }[] = [];
  if (priceRes?.ok) {
    const priceData = (await priceRes.json()) as {
      coins: Record<
        string,
        { prices: { timestamp: number; price: number }[] }
      >;
    };
    prices =
      priceData.coins?.[`coingecko:${config.geckoId}`]?.prices ?? [];
  } else {
    logUpstreamFailure("defillama-coins-chart", config.stablecoinId, priceRes?.status ?? "no-response");
  }

  let tvlHistory: { date: number; totalLiquidityUSD: number }[] = [];
  if (protocolRes?.ok) {
    const protocolData = (await protocolRes.json()) as {
      tvl?: { date: number; totalLiquidityUSD: number }[];
    };
    tvlHistory = protocolData.tvl ?? [];
  } else if (config.protocolSlug) {
    logUpstreamFailure("defillama-protocol-detail", config.stablecoinId, protocolRes?.status ?? "no-response");
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
    const [cgRes, coinRes] = await Promise.all([
      fetchWithRetry(
        cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
        DETAIL_UPSTREAM_MAX_RETRIES,
        { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
      ),
      fetchWithRetry(
        cgUrl(`/coins/${config.geckoId}?market_data=true&localization=false&tickers=false&community_data=false&developer_data=false`),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
        DETAIL_UPSTREAM_MAX_RETRIES,
        { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
      ),
    ]);

    if (!cgRes?.ok) {
      logUpstreamFailure("coingecko-market-chart", config.stablecoinId, cgRes?.status ?? "no-response");
      coinRes?.body?.cancel();
      return [];
    }

    const cgData = (await cgRes.json()) as {
      market_caps: [number, number][];
      prices?: [number, number][];
    };

    let circulatingSupply: number | undefined;
    if (coinRes?.ok) {
      const coinData = (await coinRes.json()) as {
        market_data?: { circulating_supply?: number };
      };
      circulatingSupply = coinData.market_data?.circulating_supply ?? undefined;
    } else {
      logUpstreamFailure("coingecko-coin-detail", config.stablecoinId, coinRes?.status ?? "no-response");
      coinRes?.body?.cancel();
    }

    const priceMap = buildPriceMapByDate(cgData.prices);
    tokens = buildTokenRowsFromMarketCaps(
      cgData.market_caps ?? [],
      config.pegType,
      priceMap,
      (mcap, price) => (price > 0 ? resolveMarketCap(mcap, circulatingSupply, price) : mcap),
    );
  }

  return tokens;
}
