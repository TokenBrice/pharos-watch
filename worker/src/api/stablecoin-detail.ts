import { logWorkerEventArgs } from "../lib/structured-log";
import { getCache } from "../lib/db-cache";
import { errorResponse } from "../lib/api-response";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
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
let detailRefreshesInFlight = new Map<string, Promise<SharedDetailRefreshResponse>>();

/** @internal Reset isolate-local single-flight coordination so test files can share a process. */
export function resetStablecoinDetailStateForTests(): void {
  detailRefreshesInFlight = new Map<string, Promise<SharedDetailRefreshResponse>>();
}

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
  const refreshesInFlight = detailRefreshesInFlight;
  const existing = refreshesInFlight.get(cacheKey);
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
    refreshesInFlight.delete(cacheKey);
  });

  refreshesInFlight.set(cacheKey, refresh);
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
        logWorkerEventArgs("api", "warn",
          `[detail] background refresh failed stablecoin=${config.id} error=${String(err).slice(0, 300)}`,
        );
      }),
  );
}

export const handleStablecoinDetail = async (db: D1Database, id: string, ctx: ExecutionContext, coingeckoApiKey?: string | null): Promise<Response> => {
    const cacheKey = `detail:${id}`;
    const cached = await getCache(db, cacheKey);
    const meta = TRACKED_META_BY_ID.get(id);
    // Preserve the legacy provider lookup for unknown IDs, but never schedule
    // new collection for a known non-active catalog record.
    const providerRefreshAllowed = meta == null || isActiveStablecoinMeta(meta);
    const pegType = `pegged${meta?.flags.pegCurrency ?? "USD"}`;
    const normalizedCached = cached
      ? { ...cached, value: applyCuratedDetailAddress(cached.value, meta) }
      : null;

    if (normalizedCached) {
      const age = Math.floor(Date.now() / 1000) - normalizedCached.updatedAt;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(normalizedCached.value, age);
      }
      if (!providerRefreshAllowed) {
        return createStaleCacheHitResponse(normalizedCached.value, age);
      }
      if (age >= DETAIL_STALE_CACHE_MAX_AGE_SECONDS) {
        logWorkerEventArgs("api", "warn",
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

    if (!providerRefreshAllowed) {
      return errorResponse(404, "Live detail data is unavailable for this inactive catalog record");
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
  };
