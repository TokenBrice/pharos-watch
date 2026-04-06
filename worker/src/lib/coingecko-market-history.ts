import { USER_AGENT } from "./constants";
import { cgHeaders, cgUrl } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import { cancelResponseBodyQuietly } from "./response-body";

export interface CoinGeckoMarketHistorySnapshot {
  marketCaps: [number, number][];
  prices: [number, number][];
  circulatingSupply?: number;
}

interface FetchCoinGeckoMarketHistoryOptions {
  apiKey?: string | null;
  retries?: number;
  timeoutMs?: number;
  onCoinDetailFailure?: (status: number | "no-response") => void;
}

export async function fetchCoinGeckoMarketHistory(
  geckoId: string,
  options: FetchCoinGeckoMarketHistoryOptions = {},
): Promise<CoinGeckoMarketHistorySnapshot | null> {
  const apiKey = options.apiKey ?? null;
  const retryCount = options.retries;
  const retryOptions = options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : undefined;

  const [marketChartRes, coinRes] = await Promise.all([
    fetchWithRetry(
      cgUrl(`/coins/${geckoId}/market_chart?vs_currency=usd&days=max`, apiKey),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey) },
      retryCount,
      retryOptions,
    ),
    fetchWithRetry(
      cgUrl(
        `/coins/${geckoId}?market_data=true&localization=false&tickers=false&community_data=false&developer_data=false`,
        apiKey,
      ),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey) },
      retryCount,
      retryOptions,
    ),
  ]);

  if (!marketChartRes?.ok) {
    await cancelResponseBodyQuietly(coinRes);
    return null;
  }

  const marketChart = (await marketChartRes.json()) as {
    market_caps?: [number, number][];
    prices?: [number, number][];
  };

  let circulatingSupply: number | undefined;
  if (coinRes?.ok) {
    const coinData = (await coinRes.json()) as {
      market_data?: { circulating_supply?: number };
    };
    circulatingSupply = coinData.market_data?.circulating_supply ?? undefined;
  } else {
    options.onCoinDetailFailure?.(coinRes?.status ?? "no-response");
    await cancelResponseBodyQuietly(coinRes);
  }

  return {
    marketCaps: marketChart.market_caps ?? [],
    prices: marketChart.prices ?? [],
    circulatingSupply,
  };
}
