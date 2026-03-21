import { CIRCUIT_SOURCE } from "../../lib/constants";
import { USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  buildPriceMapByDate,
  buildTokenRowsFromMarketCaps,
  type DetailResponseHelpers,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  isDetailHistoryFresh,
  logUpstreamException,
  logUpstreamFailure,
} from "./shared";

async function fetchCoinGeckoOnlyTokens(config: {
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

export async function handleCoinGeckoOnlyDetail(
  config: {
    db: D1Database;
    stablecoinId: string;
    geckoId: string;
    pegType: string;
    coingeckoApiKey?: string | null;
  },
  detail: DetailResponseHelpers,
): Promise<Response> {
  const cgDetailAllowed = await shouldAttemptFetch(config.db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS);
  if (!cgDetailAllowed) {
    const fallback = await detail.trySupplyHistoryFallback("coingecko-circuit-open");
    if (fallback) return fallback;
    return detail.staleCacheOrError(503, "CoinGecko detail circuit open");
  }

  try {
    const upstreamTokens = await fetchCoinGeckoOnlyTokens(config);
    const historyFresh = isDetailHistoryFresh(upstreamTokens);
    await recordOutcomeSafe(
      config.db,
      CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS,
      upstreamTokens.length > 0 && historyFresh,
    );

    const tokens = await detail.resolveTokensWithSupplyHistoryFallback(upstreamTokens, {
      emptyReason: "coingecko-history-empty",
      staleReason: "coingecko-history-stale",
    });

    return detail.createFreshResponseFromTokens(tokens);
  } catch (err) {
    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, false);
    logUpstreamException("coingecko-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("coingecko-upstream-failure");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, "Failed to fetch CoinGecko data");
  }
}
