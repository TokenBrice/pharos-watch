import { getCache } from "../lib/db-cache";
import { withErrorHandler } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  CACHE_TTL_SECONDS,
  DETAIL_STALE_CACHE_MAX_AGE_SECONDS,
  createDetailResponseHelpers,
  createFreshCacheHitResponse,
  createStaleCacheHitResponse,
} from "./stablecoin-detail/shared";
import { routeStablecoinDetail } from "./stablecoin-detail/router";

const detailRefreshesInFlight = new Map<string, Promise<Response>>();

function startStablecoinDetailRefresh(config: {
  db: D1Database;
  id: string;
  pegType: string;
  cached: { value: string; updatedAt: number } | null;
  ctx: ExecutionContext;
  coingeckoApiKey?: string | null;
}): Promise<Response> {
  const cacheKey = `detail:${config.id}`;
  const existing = detailRefreshesInFlight.get(cacheKey);
  if (existing) return existing;

  const refresh = (async () => {
    const detail = createDetailResponseHelpers({
      db: config.db,
      stablecoinId: config.id,
      pegType: config.pegType,
      cached: config.cached,
      execCtx: config.ctx,
    });
    return routeStablecoinDetail(
      {
        db: config.db,
        stablecoinId: config.id,
        pegType: config.pegType,
        coingeckoApiKey: config.coingeckoApiKey,
      },
      detail,
    );
  })().finally(() => {
    detailRefreshesInFlight.delete(cacheKey);
  });

  detailRefreshesInFlight.set(cacheKey, refresh);
  return refresh;
}

function scheduleStablecoinDetailRefresh(config: {
  db: D1Database;
  id: string;
  pegType: string;
  cached: { value: string; updatedAt: number };
  ctx: ExecutionContext;
  coingeckoApiKey?: string | null;
}): void {
  const refresh = startStablecoinDetailRefresh(config);
  config.ctx.waitUntil(
    refresh
      .then((response) => response.body?.cancel().catch(() => undefined))
      .catch((err) => {
        console.warn(
          `[detail] background refresh failed stablecoin=${config.id} error=${String(err).slice(0, 300)}`,
        );
      }),
  );
}

export const handleStablecoinDetail = withErrorHandler(
  "stablecoin-detail",
  async (db: D1Database, id: string, ctx: ExecutionContext, coingeckoApiKey?: string | null): Promise<Response> => {
    const cacheKey = `detail:${id}`;
    const cached = await getCache(db, cacheKey);
    const meta = TRACKED_META_BY_ID.get(id);
    const pegType = `pegged${meta?.flags.pegCurrency ?? "USD"}`;

    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(cached.value, age);
      }
      if (age >= DETAIL_STALE_CACHE_MAX_AGE_SECONDS) {
        console.warn(
          `[detail] cache too stale stablecoin=${id} age=${age} max=${DETAIL_STALE_CACHE_MAX_AGE_SECONDS}; refreshing synchronously`,
        );
        const response = await startStablecoinDetailRefresh({
          db,
          id,
          pegType,
          cached: null,
          ctx,
          coingeckoApiKey,
        });
        return response.clone();
      }
      scheduleStablecoinDetailRefresh({ db, id, pegType, cached, ctx, coingeckoApiKey });
      return createStaleCacheHitResponse(cached.value, age);
    }

    const response = await startStablecoinDetailRefresh({
      db,
      id,
      pegType,
      cached: null,
      ctx,
      coingeckoApiKey,
    });
    return response.clone();
  },
);
