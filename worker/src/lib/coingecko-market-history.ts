import { isCoinGeckoHistoryAllowed } from "./solomon-usdv-identity";
import { USER_AGENT } from "./constants";
import { cgHeaders, cgUrl } from "./coingecko";
import { fetchJsonWithSchema } from "./fetch-retry";
import {
  CoinGeckoCoinDetailSchema,
  CoinGeckoMarketChartSchema,
} from "./external-api-schemas";

export interface CoinGeckoMarketHistorySnapshot {
  marketCaps: [number, number][];
  prices: [number, number][];
  circulatingSupply?: number;
}

interface FetchCoinGeckoMarketHistoryOptions {
  apiKey?: string | null;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  range?: {
    startSec?: number | null;
    endSec?: number | null;
  };
  onCoinDetailFailure?: (status: number | "no-response") => void;
}

export async function fetchCoinGeckoMarketHistory(
  geckoId: string,
  options: FetchCoinGeckoMarketHistoryOptions = {},
): Promise<CoinGeckoMarketHistorySnapshot | null> {
  if (!isCoinGeckoHistoryAllowed(geckoId)) return null;
  const apiKey = options.apiKey ?? null;
  const retryCount = options.retries;
  const retryOptions = options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : undefined;
  const rangeStart = options.range?.startSec ?? null;
  const rangeEnd = options.range?.endSec ?? Math.floor(Date.now() / 1000);
  const marketChartPath = rangeStart != null || options.range?.endSec != null
    ? `/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${rangeStart ?? 0}&to=${rangeEnd}`
    : `/coins/${geckoId}/market_chart?vs_currency=usd&days=max`;

  const [marketChartResult, coinResult] = await Promise.all([
    fetchJsonWithSchema(
      cgUrl(marketChartPath, apiKey),
      CoinGeckoMarketChartSchema,
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey), signal: options.signal },
      retryCount,
      retryOptions,
    ),
    fetchJsonWithSchema(
      cgUrl(
        `/coins/${geckoId}?market_data=true&localization=false&tickers=false&community_data=false&developer_data=false`,
        apiKey,
      ),
      CoinGeckoCoinDetailSchema,
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey), signal: options.signal },
      retryCount,
      retryOptions,
    ),
  ]);

  if (!marketChartResult?.response.ok || !marketChartResult.success) {
    return null;
  }

  const marketChart = marketChartResult.body;

  let circulatingSupply: number | undefined;
  if (coinResult?.response.ok && coinResult.success) {
    circulatingSupply = coinResult.body.market_data?.circulating_supply;
  } else {
    options.onCoinDetailFailure?.(coinResult?.response.status ?? "no-response");
  }

  return {
    marketCaps: marketChart.market_caps ?? [],
    prices: marketChart.prices,
    circulatingSupply,
  };
}
