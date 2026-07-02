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
import { applyCuratedDetailAddress } from "./stablecoin-detail/defillama";
import { routeStablecoinDetail } from "./stablecoin-detail/router";

interface SharedDetailRefreshResponse {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
}

// Per-isolate, best-effort de-dupe of concurrent detail refreshes for the same coin.
// This Map is scoped to a single Worker isolate and does NOT serialize across isolates,
// so under load multiple isolates can each run one refresh for the same coin. Cross-isolate
// herd protection relies on the circuit breaker + D1 cache (stale-serve), not this Map.
// Store bytes instead of Response objects so overlapping consumers never share a live body stream.
const detailRefreshesInFlight = new Map<string, Promise<SharedDetailRefreshResponse>>();

function responseStatusForbidsBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

async function materializeSharedResponse(response: Response): Promise<SharedDetailRefreshResponse> {
  return {
    body: await response.arrayBuffer(),
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  };
}

function createResponseFromSharedResponse(response: SharedDetailRefreshResponse): Response {
  return new Response(responseStatusForbidsBody(response.status) ? null : response.body.slice(0), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function startStablecoinDetailRefresh(config: {
  db: D1Database;
  id: string;
  pegType: string;
  cached: { value: string; updatedAt: number } | null;
  ctx: ExecutionContext;
  coingeckoApiKey?: string | null;
}): Promise<SharedDetailRefreshResponse> {
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
    const response = await routeStablecoinDetail(
      {
        db: config.db,
        stablecoinId: config.id,
        pegType: config.pegType,
        coingeckoApiKey: config.coingeckoApiKey,
      },
      detail,
    );
    return materializeSharedResponse(response);
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
      .then(() => undefined)
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
    const normalizedCached = cached
      ? { ...cached, value: applyCuratedDetailAddress(cached.value, meta) }
      : null;

    if (normalizedCached) {
      const age = Math.floor(Date.now() / 1000) - normalizedCached.updatedAt;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(normalizedCached.value, age);
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
        return createResponseFromSharedResponse(response);
      }
      scheduleStablecoinDetailRefresh({ db, id, pegType, cached: normalizedCached, ctx, coingeckoApiKey });
      return createStaleCacheHitResponse(normalizedCached.value, age);
    }

    const response = await startStablecoinDetailRefresh({
      db,
      id,
      pegType,
      cached: null,
      ctx,
      coingeckoApiKey,
    });
    return createResponseFromSharedResponse(response);
  },
);
