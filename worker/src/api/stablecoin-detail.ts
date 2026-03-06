import { getCache, setCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { recordOutcome, shouldAttemptFetch } from "../lib/circuit-breaker";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { fetchCommodityTokens } from "./stablecoin-detail/commodity";
import { fetchCoinGeckoOnlyTokens } from "./stablecoin-detail/coingecko-only";
import { normalizeDefiLlamaDetailBody } from "./stablecoin-detail/defillama";
import {
  CACHE_TTL_SECONDS,
  createFreshCacheHitResponse,
  createFreshUpstreamResponse,
  fetchSupplyHistoryFallback,
  staleCacheOrError,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  logUpstreamException,
  logUpstreamFailure,
} from "./stablecoin-detail/shared";

export const handleStablecoinDetail = withErrorHandler("stablecoin-detail", async (
  db: D1Database,
  id: string,
  ctx: ExecutionContext,
): Promise<Response> => {
  const cacheKey = `detail:${id}`;
  const cached = await getCache(db, cacheKey);
  const safeRecordOutcome = async (source: string, success: boolean): Promise<void> => {
    try {
      await recordOutcome(db, source, success);
    } catch {
      // Non-blocking for detail endpoint.
    }
  };

  if (cached) {
    const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
    if (age < CACHE_TTL_SECONDS) {
      return createFreshCacheHitResponse(cached.value, age);
    }
  }

  const meta = TRACKED_META_BY_ID.get(id);
  const isCommodity =
    !!meta &&
    (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") &&
    !!meta.geckoId;

  if (isCommodity) {
    const config = {
      stablecoinId: id,
      geckoId: meta.geckoId!,
      protocolSlug: meta.protocolSlug ?? "",
      pegType: `pegged${meta.flags.pegCurrency}`,
    };

    try {
      let tokens = await fetchCommodityTokens(config);
      if (tokens.length === 0) {
        const fallbackTokens = await fetchSupplyHistoryFallback(db, id, config.pegType);
        if (fallbackTokens.length > 0) {
          tokens = fallbackTokens;
        }
      }

      const body = JSON.stringify({ tokens });
      ctx.waitUntil(setCache(db, cacheKey, body));
      return createFreshUpstreamResponse(body);
    } catch (err) {
      logUpstreamException("commodity-detail", id, err);
      return staleCacheOrError(cached, 502, "Failed to fetch commodity token data");
    }
  }

  const isCgOnly = meta?.detailProvider === "coingecko" && !!meta?.geckoId;
  if (isCgOnly) {
    const cgDetailAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS);
    if (!cgDetailAllowed) {
      return staleCacheOrError(cached, 503, "CoinGecko detail circuit open");
    }

    const pegType = `pegged${meta.flags.pegCurrency}`;

    try {
      let tokens = await fetchCoinGeckoOnlyTokens({
        stablecoinId: id,
        geckoId: meta.geckoId!,
        pegType,
      });
      await safeRecordOutcome(CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, tokens.length > 0);
      if (tokens.length === 0) {
        tokens = await fetchSupplyHistoryFallback(db, id, pegType);
      }

      const body = JSON.stringify({ tokens });
      ctx.waitUntil(setCache(db, cacheKey, body));
      return createFreshUpstreamResponse(body);
    } catch (err) {
      await safeRecordOutcome(CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, false);
      logUpstreamException("coingecko-detail", id, err);
      return staleCacheOrError(cached, 502, "Failed to fetch CoinGecko data");
    }
  }

  const dlId = meta?.llamaId ?? id;
  const dlDetailAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL);
  if (!dlDetailAllowed) {
    return staleCacheOrError(cached, 503, "DefiLlama detail circuit open");
  }

  try {
    const res = await fetchWithRetry(
      `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`,
      undefined,
      DETAIL_UPSTREAM_MAX_RETRIES,
      { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
    );

    if (!res?.ok) {
      await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      logUpstreamFailure("defillama-stablecoin-detail", id, res?.status ?? "no-response");
      return staleCacheOrError(cached, 502, `Failed to fetch stablecoin ${id}`);
    }

    const upstreamBody = await res.text();
    let body: string;
    try {
      body = normalizeDefiLlamaDetailBody(upstreamBody, meta);
    } catch (err) {
      await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      logUpstreamException("defillama-stablecoin-detail-parse", id, err);
      return staleCacheOrError(cached, 502, `Invalid upstream data for stablecoin ${id}`);
    }

    ctx.waitUntil(setCache(db, cacheKey, body));
    await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, true);
    return createFreshUpstreamResponse(body);
  } catch (err) {
    await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
    logUpstreamException("defillama-stablecoin-detail", id, err);
    return staleCacheOrError(cached, 502, `Failed to fetch stablecoin ${id}`);
  }
});
