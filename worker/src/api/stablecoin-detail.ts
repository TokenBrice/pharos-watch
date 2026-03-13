import { getCache, setCache } from "../lib/db-cache";
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
  getLatestDetailTokenDate,
  isDetailHistoryFresh,
  staleCacheOrError,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  logUpstreamException,
  logUpstreamFailure,
} from "./stablecoin-detail/shared";

export const handleStablecoinDetail = withErrorHandler(
  "stablecoin-detail",
  async (db: D1Database, id: string, ctx: ExecutionContext): Promise<Response> => {
    const cacheKey = `detail:${id}`;
    const cached = await getCache(db, cacheKey);
    const meta = TRACKED_META_BY_ID.get(id);
    const queueCacheWrite = (body: string): void => {
      ctx.waitUntil(
        (async () => {
          try {
            await setCache(db, cacheKey, body);
          } catch (err) {
            console.error(
              `[detail] cache write failed stablecoin=${id} bytes=${body.length} error=${String(err).slice(0, 300)}`,
            );
          }
        })(),
      );
    };
    const safeRecordOutcome = async (source: string, success: boolean): Promise<void> => {
      try {
        await recordOutcome(db, source, success);
      } catch {
        // Non-blocking for detail endpoint.
      }
    };
    const pegType = `pegged${meta?.flags.pegCurrency ?? "USD"}`;
    const loadSupplyHistoryFallback = async (
      reason: string,
      latestTokenDate?: number | null,
    ): Promise<Record<string, unknown>[]> => {
      const tokens = await fetchSupplyHistoryFallback(db, id, pegType);
      if (tokens.length > 0) {
        const latestSuffix = latestTokenDate != null ? ` latest=${latestTokenDate}` : "";
        console.warn(
          `[detail] fallback source=supply_history stablecoin=${id} reason=${reason} points=${tokens.length}${latestSuffix}`,
        );
      }
      return tokens;
    };
    const trySupplyHistoryFallback = async (
      reason: string,
      latestTokenDate?: number | null,
    ): Promise<Response | null> => {
      const tokens = await loadSupplyHistoryFallback(reason, latestTokenDate);
      if (tokens.length === 0) return null;
      const body = JSON.stringify({ tokens });
      queueCacheWrite(body);
      return createFreshUpstreamResponse(body);
    };

    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(cached.value, age);
      }
    }

    const isCommodity =
      !!meta && (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") && !!meta.geckoId;

    if (isCommodity) {
      const config = {
        stablecoinId: id,
        geckoId: meta.geckoId!,
        protocolSlug: meta.protocolSlug ?? "",
        pegType,
      };

      try {
        let tokens = await fetchCommodityTokens(config);
        if (tokens.length === 0) {
          const fallbackTokens = await loadSupplyHistoryFallback("commodity-history-empty");
          if (fallbackTokens.length > 0) {
            tokens = fallbackTokens;
          }
        } else if (!isDetailHistoryFresh(tokens)) {
          const fallbackTokens = await loadSupplyHistoryFallback(
            "commodity-history-stale",
            getLatestDetailTokenDate(tokens),
          );
          if (fallbackTokens.length > 0) {
            tokens = fallbackTokens;
          }
        }

        const body = JSON.stringify({ tokens });
        queueCacheWrite(body);
        return createFreshUpstreamResponse(body);
      } catch (err) {
        logUpstreamException("commodity-detail", id, err);
        const fallback = await trySupplyHistoryFallback("commodity-upstream-failure");
        if (fallback) return fallback;
        return staleCacheOrError(cached, 502, "Failed to fetch commodity token data");
      }
    }

    const isCgOnly = meta?.detailProvider === "coingecko" && !!meta?.geckoId;
    if (isCgOnly) {
      const cgDetailAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS);
      if (!cgDetailAllowed) {
        const fallback = await trySupplyHistoryFallback("coingecko-circuit-open");
        if (fallback) return fallback;
        return staleCacheOrError(cached, 503, "CoinGecko detail circuit open");
      }

      try {
        let tokens = await fetchCoinGeckoOnlyTokens({
          stablecoinId: id,
          geckoId: meta.geckoId!,
          pegType,
        });
        const historyFresh = isDetailHistoryFresh(tokens);
        await safeRecordOutcome(CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, tokens.length > 0 && historyFresh);
        if (tokens.length === 0) {
          const fallbackTokens = await loadSupplyHistoryFallback("coingecko-history-empty");
          if (fallbackTokens.length > 0) {
            tokens = fallbackTokens;
          }
        } else if (!historyFresh) {
          const fallbackTokens = await loadSupplyHistoryFallback(
            "coingecko-history-stale",
            getLatestDetailTokenDate(tokens),
          );
          if (fallbackTokens.length > 0) {
            tokens = fallbackTokens;
          }
        }

        const body = JSON.stringify({ tokens });
        queueCacheWrite(body);
        return createFreshUpstreamResponse(body);
      } catch (err) {
        await safeRecordOutcome(CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, false);
        logUpstreamException("coingecko-detail", id, err);
        const fallback = await trySupplyHistoryFallback("coingecko-upstream-failure");
        if (fallback) return fallback;
        return staleCacheOrError(cached, 502, "Failed to fetch CoinGecko data");
      }
    }

    const dlId = meta?.llamaId ?? id;
    const dlDetailAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL);
    if (!dlDetailAllowed) {
      const fallback = await trySupplyHistoryFallback("defillama-circuit-open");
      if (fallback) return fallback;
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
        const fallback = await trySupplyHistoryFallback("defillama-upstream-failure");
        if (fallback) return fallback;
        return staleCacheOrError(cached, 502, `Failed to fetch stablecoin ${id}`);
      }

      const upstreamBody = await res.text();
      let body: string;
      try {
        body = normalizeDefiLlamaDetailBody(upstreamBody, meta);
      } catch (err) {
        await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
        logUpstreamException("defillama-stablecoin-detail-parse", id, err);
        const fallback = await trySupplyHistoryFallback("defillama-parse-failure");
        if (fallback) return fallback;
        return staleCacheOrError(cached, 502, `Invalid upstream data for stablecoin ${id}`);
      }

      queueCacheWrite(body);
      await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, true);
      return createFreshUpstreamResponse(body);
    } catch (err) {
      await safeRecordOutcome(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      logUpstreamException("defillama-stablecoin-detail", id, err);
      const fallback = await trySupplyHistoryFallback("defillama-exception");
      if (fallback) return fallback;
      return staleCacheOrError(cached, 502, `Failed to fetch stablecoin ${id}`);
    }
  },
);
