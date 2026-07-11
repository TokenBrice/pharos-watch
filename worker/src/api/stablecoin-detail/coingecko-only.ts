import { CIRCUIT_SOURCE } from "../../lib/constants";
import { USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import {
  buildPriceMapByDate,
  buildTokenRowsFromMarketCaps,
  type DetailResponseHelpers,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  logUpstreamException,
  logUpstreamFailure,
} from "./shared";
import { handleCacheBackedDetail } from "./cache-fallback";

async function fetchCoinGeckoOnlyTokens(config: {
  stablecoinId: string;
  geckoId: string;
  pegType: string;
  coingeckoApiKey?: string | null;
}): Promise<{ tokens: Record<string, unknown>[]; upstreamOk: boolean }> {
  const apiKey = config.coingeckoApiKey ?? null;
  const cgResult = await fetchJsonWithRetry<{
    market_caps: [number, number][];
    prices?: [number, number][];
  }>(
    cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`, apiKey),
    { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey) },
    DETAIL_UPSTREAM_MAX_RETRIES,
    { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
  );

  if (!cgResult?.response.ok) {
    logUpstreamFailure(
      "coingecko-market-chart",
      config.stablecoinId,
      cgResult?.response.status ?? "no-response",
    );
    return { tokens: [], upstreamOk: false };
  }

  const cgData = cgResult.body;

  const priceMap = buildPriceMapByDate(cgData.prices);
  return {
    tokens: buildTokenRowsFromMarketCaps(
      cgData.market_caps ?? [],
      config.pegType,
      priceMap,
    ),
    upstreamOk: true,
  };
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
    const { tokens: upstreamTokens, upstreamOk } = await fetchCoinGeckoOnlyTokens(config);
    await recordOutcomeSafe(
      config.db,
      CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS,
      upstreamOk,
    );

    const tokens = await detail.resolveTokensWithSupplyHistoryFallback(upstreamTokens, {
      emptyReason: "coingecko-history-empty",
      staleReason: "coingecko-history-stale",
    });
    if (tokens.length === 0) {
      return handleCacheBackedDetail(
        {
          db: config.db,
          stablecoinId: config.stablecoinId,
          pegType: config.pegType,
        },
        detail,
      );
    }

    return detail.createFreshResponseFromTokens(tokens);
  } catch (err) {
    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, false);
    logUpstreamException("coingecko-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("coingecko-upstream-failure");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, "Failed to fetch CoinGecko data");
  }
}
