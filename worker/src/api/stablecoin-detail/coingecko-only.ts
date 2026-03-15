import { USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  buildPriceMapByDate,
  buildTokenRowsFromMarketCaps,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  logUpstreamFailure,
} from "./shared";

export async function fetchCoinGeckoOnlyTokens(config: {
  stablecoinId: string;
  geckoId: string;
  pegType: string;
  coingeckoApiKey?: string | null;
}): Promise<Record<string, unknown>[]> {
  const apiKey = config.coingeckoApiKey ?? null;
  const cgRes = await fetchWithRetry(
    cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`, apiKey),
    { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey) },
    DETAIL_UPSTREAM_MAX_RETRIES,
    { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
  );

  if (!cgRes?.ok) {
    logUpstreamFailure("coingecko-market-chart", config.stablecoinId, cgRes?.status ?? "no-response");
    return [];
  }

  const cgData = (await cgRes.json()) as {
    market_caps: [number, number][];
    prices?: [number, number][];
  };

  const priceMap = buildPriceMapByDate(cgData.prices);
  return buildTokenRowsFromMarketCaps(
    cgData.market_caps ?? [],
    config.pegType,
    priceMap,
  );
}
