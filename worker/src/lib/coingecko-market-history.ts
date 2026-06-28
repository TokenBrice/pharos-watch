import { USER_AGENT } from "./constants";
import { cgHeaders, cgUrl } from "./coingecko";
import { fetchJsonWithRetry } from "./fetch-retry";

export interface CoinGeckoMarketHistorySnapshot {
  marketCaps: [number, number][];
  prices: [number, number][];
  circulatingSupply?: number;
}

interface CoinGeckoMarketChartPayload {
  market_caps?: [number, number][];
  prices?: [number, number][];
}

interface CoinGeckoCoinDetailPayload {
  market_data?: { circulating_supply?: number };
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
  const apiKey = options.apiKey ?? null;
  const retryCount = options.retries;
  const retryOptions = options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : undefined;
  const rangeStart = options.range?.startSec ?? null;
  const rangeEnd = options.range?.endSec ?? Math.floor(Date.now() / 1000);
  const marketChartPath = rangeStart != null || options.range?.endSec != null
    ? `/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${rangeStart ?? 0}&to=${rangeEnd}`
    : `/coins/${geckoId}/market_chart?vs_currency=usd&days=max`;

  const [marketChartResult, coinResult] = await Promise.all([
    fetchJsonWithRetry<CoinGeckoMarketChartPayload>(
      cgUrl(marketChartPath, apiKey),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey), signal: options.signal },
      retryCount,
      retryOptions,
    ),
    fetchJsonWithRetry<CoinGeckoCoinDetailPayload>(
      cgUrl(
        `/coins/${geckoId}?market_data=true&localization=false&tickers=false&community_data=false&developer_data=false`,
        apiKey,
      ),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey), signal: options.signal },
      retryCount,
      retryOptions,
    ),
  ]);

  if (!marketChartResult?.response.ok) {
    return null;
  }

  const marketChart = marketChartResult.body;

  let circulatingSupply: number | undefined;
  if (coinResult?.response.ok) {
    const coinData = coinResult.body;
    circulatingSupply = coinData.market_data?.circulating_supply ?? undefined;
  } else {
    options.onCoinDetailFailure?.(coinResult?.response.status ?? "no-response");
  }

  return {
    marketCaps: marketChart.market_caps ?? [],
    prices: marketChart.prices ?? [],
    circulatingSupply,
  };
}
