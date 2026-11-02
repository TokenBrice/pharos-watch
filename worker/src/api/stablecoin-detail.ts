import { logWorkerEventArgs } from "../lib/structured-log";
import { getCache } from "../lib/db-cache";
import { errorResponse } from "../lib/api-response";
import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildFreshnessMeta } from "../lib/api-freshness";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import {
  CACHE_TTL_SECONDS,
  DETAIL_STALE_CACHE_MAX_AGE_SECONDS,
  createDetailResponseHelpers,
  createFreshCacheHitResponse,
  createStaleCacheHitResponse,
} from "./stablecoin-detail/shared";
import { applyCuratedDetailAddress, resetDefiLlamaDetailStateForTests } from "./stablecoin-detail/defillama";
import { routeStablecoinDetail } from "./stablecoin-detail/router";
import { enrichMissingDetailPrice } from "./stablecoin-detail/price";

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
  resetDefiLlamaDetailStateForTests();
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

const DETAIL_REFRESH_LEASE_PREFIX = "detail-refresh:";
const DETAIL_REFRESH_LEASE_TTL_SECONDS = 60;

interface DetailRefreshLease {
  key: string;
  owner: string;
}

type DetailRefreshLeaseClaim =
  | { state: "claimed"; lease: DetailRefreshLease }
  | { state: "busy" }
  | { state: "unavailable" };

function detailRefreshLeaseKey(id: string): string {
  return `${DETAIL_REFRESH_LEASE_PREFIX}${id}`;
}

function createDetailRefreshOwner(id: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = cryptoObj?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${detailRefreshLeaseKey(id)}:${suffix}`;
}

/**
 * Cross-isolate single-flight for provider detail refreshes. The in-memory Map
 * above only dedupes one isolate; this short D1 lease also supplies a cooldown
 * after a failed refresh, so a cache-busting caller cannot force provider work
 * on every request. The lease value is stored in its own cache key; the
 * authoritative detail cache entry is never touched.
 */
async function claimDetailRefreshLease(db: D1Database, id: string): Promise<DetailRefreshLeaseClaim> {
  const key = detailRefreshLeaseKey(id);
  const owner = createDetailRefreshOwner(id);
  const now = Math.floor(Date.now() / 1000);
  try {
    const claimed = await db
      .prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE NOT json_valid(cache.value) OR COALESCE(json_extract(cache.value, '$.leaseUntil'), 0) <= ?
         RETURNING key`,
      )
      .bind(key, JSON.stringify({ owner, leaseUntil: now + DETAIL_REFRESH_LEASE_TTL_SECONDS }), now, now)
      .first<{ key: string }>();
    return claimed ? { state: "claimed", lease: { key, owner } } : { state: "busy" };
  } catch (err) {
    // A lease write failure must not turn a servable detail read into an error.
    logWorkerEventArgs("api", "warn",
      `[detail] refresh lease unavailable stablecoin=${id} error=${String(err).slice(0, 300)}`,
    );
    return { state: "unavailable" };
  }
}

async function releaseDetailRefreshLease(db: D1Database, lease: DetailRefreshLease): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM cache WHERE key = ? AND json_valid(value) AND json_extract(value, '$.owner') = ?")
      .bind(lease.key, lease.owner)
      .run();
  } catch (err) {
    // The lease expires on its own; release is only a fast-path cleanup.
    logWorkerEventArgs("api", "warn",
      `[detail] refresh lease release failed key=${lease.key} error=${String(err).slice(0, 300)}`,
    );
  }
}

function releaseDetailRefreshLeaseAfterSuccess(
  refresh: Promise<SharedDetailRefreshResponse>,
  db: D1Database,
  lease: DetailRefreshLease,
): Promise<SharedDetailRefreshResponse> {
  return refresh.then(async (response) => {
    if (response.status >= 200 && response.status < 300) {
      await releaseDetailRefreshLease(db, lease);
    }
    return response;
  });
}

function scheduleStablecoinDetailRefresh(config: {
  db: D1Database;
  id: string;
  pegType: string;
  cached: { value: string; updatedAt: number };
  ctx: ExecutionContext;
  coingeckoApiKey?: string | null;
}, lease?: DetailRefreshLease): void {
  const refresh = startStablecoinDetailRefresh(config);
  const settled = lease ? releaseDetailRefreshLeaseAfterSuccess(refresh, config.db, lease) : refresh;
  config.ctx.waitUntil(
    settled
      .then(() => undefined)
      .catch((err) => {
        logWorkerEventArgs("api", "warn",
          `[detail] background refresh failed stablecoin=${config.id} error=${String(err).slice(0, 300)}`,
        );
      }),
  );
}

const resolveStablecoinDetail = async (db: D1Database, id: string, ctx: ExecutionContext, coingeckoApiKey?: string | null): Promise<Response> => {
    const cacheKey = `detail:${id}`;
    const cached = await getCache(db, cacheKey);
    const meta = TRACKED_META_BY_ID.get(id);
    // Preserve the legacy provider lookup for unknown IDs, but never schedule
    // new collection for a known non-active catalog record.
    const providerRefreshAllowed = meta == null || isActiveStablecoinMeta(meta);
    const pegType = `pegged${meta?.flags.pegCurrency ?? "USD"}`;
    const cacheTimestamp = assessFreshnessTimestamp(Math.floor(Date.now() / 1000), cached?.updatedAt);
    const normalizedCached = cached && cacheTimestamp.reason == null
      ? { ...cached, value: applyCuratedDetailAddress(cached.value, meta) }
      : null;

    if (normalizedCached && cacheTimestamp.ageSeconds != null) {
      const age = cacheTimestamp.ageSeconds;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(normalizedCached.value, age, normalizedCached.updatedAt);
      }
      if (!providerRefreshAllowed) {
        return createStaleCacheHitResponse(normalizedCached.value, age, normalizedCached.updatedAt);
      }
      const withinStaleWindow = age < DETAIL_STALE_CACHE_MAX_AGE_SECONDS;
      const staleResponse = createStaleCacheHitResponse(normalizedCached.value, age, normalizedCached.updatedAt);
      const freshness = buildFreshnessMeta(normalizedCached.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoin-detail");
      if (freshness.status !== "fresh") {
        const leaseClaim = await claimDetailRefreshLease(db, id);
        if (leaseClaim.state === "busy" && withinStaleWindow) return staleResponse;
        logWorkerEventArgs("api", "warn",
          `[detail] cache past freshness budget stablecoin=${id} age=${age}; refreshing synchronously`,
        );
        const refresh = startStablecoinDetailRefresh({
          db,
          id,
          pegType,
          cached: withinStaleWindow ? normalizedCached : null,
          ctx,
          coingeckoApiKey,
        });
        const response = leaseClaim.state === "claimed"
          ? await releaseDetailRefreshLeaseAfterSuccess(refresh, db, leaseClaim.lease)
          : await refresh;
        return createResponseFromSharedResponse(response);
      }
      const leaseClaim = await claimDetailRefreshLease(db, id);
      if (leaseClaim.state === "busy") return staleResponse;
      scheduleStablecoinDetailRefresh(
        { db, id, pegType, cached: normalizedCached, ctx, coingeckoApiKey },
        leaseClaim.state === "claimed" ? leaseClaim.lease : undefined,
      );
      return staleResponse;
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

export const handleStablecoinDetail = async (db: D1Database, id: string, ctx: ExecutionContext, coingeckoApiKey?: string | null): Promise<Response> => {
  const response = await resolveStablecoinDetail(db, id, ctx, coingeckoApiKey);
  const meta = TRACKED_META_BY_ID.get(id);
  return meta && isActiveStablecoinMeta(meta)
    ? enrichMissingDetailPrice(db, id, response)
    : response;
};
