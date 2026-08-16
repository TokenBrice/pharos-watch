import { logWorkerEventArgs } from "../../lib/structured-log";
import { setCache } from "../../lib/db-cache";
import { buildPerCoinCacheControl, PER_COIN_CACHE_TTL_SECONDS } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CACHE_PROFILES, DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../../lib/constants";
import { binarySearchNearest } from "../../lib/binary-search";
import { errorResponse } from "../../lib/api-utils";
import { claimDetailCacheGeneration, publishDetailCacheGeneration } from "../../lib/detail-cache-generation";
import { logWorkerEvent } from "../../lib/structured-log";

export const CACHE_TTL_SECONDS = PER_COIN_CACHE_TTL_SECONDS;
export const DETAIL_UPSTREAM_TIMEOUT_MS = 12_000;
export const DETAIL_UPSTREAM_MAX_RETRIES = 2;
export const DETAIL_STALE_CACHE_MAX_AGE_SECONDS = DAY_SECONDS;
const DETAIL_HISTORY_MAX_AGE_SECONDS = 3 * DAY_SECONDS;
// D1 caps a single value at 2 MiB (2,097,152 B); leave headroom so the write
// is refused here (with a failure marker) instead of erroring inside D1.
const DETAIL_CACHE_MAX_VALUE_BYTES = 1_900_000;

type DetailCacheEntry = { value: string; updatedAt: number } | null;
type DetailTokens = Record<string, unknown>[];
type DefiLlamaCoinChartPricePoint = { timestamp: number; price: number };

interface DefiLlamaCoinChartEntry {
  prices?: DefiLlamaCoinChartPricePoint[];
}

interface DefiLlamaCoinChartResponse {
  coins?: Record<string, DefiLlamaCoinChartEntry | undefined>;
}

export interface DetailResponseHelpers {
  cached: DetailCacheEntry;
  createFreshResponseFromBody(body: string): Response;
  createFreshResponseFromTokens(tokens: DetailTokens): Response;
  resolveTokensWithSupplyHistoryFallback(
    tokens: DetailTokens,
    reasons: { emptyReason: string; staleReason: string },
  ): Promise<DetailTokens>;
  staleCacheOrError(status: number, message: string): Response;
  trySupplyHistoryFallback(reason: string, latestTokenDate?: number | null): Promise<Response | null>;
}

export function logUpstreamFailure(
  source: string,
  stablecoinId: string,
  status: number | "no-response",
): void {
  logWorkerEventArgs("api", "warn", `[detail] upstream failure source=${source} stablecoin=${stablecoinId} status=${status}`);
}

export function logUpstreamException(
  source: string,
  stablecoinId: string,
  err: unknown,
): void {
  logWorkerEventArgs("api", "error",
    `[detail] upstream exception source=${source} stablecoin=${stablecoinId} error=${String(err).slice(0, 300)}`,
  );
}

function createJsonResponse(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

export function createFreshCacheHitResponse(cachedValue: string, ageSeconds: number): Response {
  return createJsonResponse(
    cachedValue,
    buildPerCoinCacheControl(CACHE_TTL_SECONDS - ageSeconds),
  );
}

export function createStaleCacheHitResponse(cachedValue: string, ageSeconds: number): Response {
  return new Response(cachedValue, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.noStore,
      "X-Data-Age": String(Math.max(0, ageSeconds)),
      "Warning": "110 - \"Stablecoin detail cache is stale; refresh scheduled\"",
    },
  });
}

function createFreshUpstreamResponse(body: string): Response {
  return createJsonResponse(body, buildPerCoinCacheControl(CACHE_TTL_SECONDS));
}

function createStaleCacheResponse(cached: DetailCacheEntry): Response | null {
  if (!cached) return null;
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - cached.updatedAt);
  return new Response(cached.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.noStore,
      "X-Data-Age": String(ageSeconds),
      "Warning": "110 - \"Stablecoin detail cache is stale; refresh failed\"",
    },
  });
}

function staleCacheOrError(
  cached: DetailCacheEntry,
  status: number,
  message: string,
): Response {
  return createStaleCacheResponse(cached) ?? errorResponse(status, message);
}

export function createDetailResponseHelpers(config: {
  db: D1Database;
  stablecoinId: string;
  pegType: string;
  cached: DetailCacheEntry;
  execCtx: ExecutionContext;
}): DetailResponseHelpers {
  const cacheKey = `detail:${config.stablecoinId}`;
  // Failed/oversized cache writes used to vanish into sampled console logs,
  // leaving flagship coins on a synchronous-refetch-per-request path for
  // weeks. A small marker row makes the failure visible to the staleness
  // watchdog, which alerts on fresh markers.
  const recordCacheWriteFailure = async (reason: string, bytes: number): Promise<void> => {
    try {
      await setCache(
        config.db,
        `${DETAIL_WRITE_FAILURE_KEY_PREFIX}${config.stablecoinId}`,
        JSON.stringify({ reason, bytes }),
      );
    } catch {
      // D1 itself is unavailable; cron telemetry covers that failure mode.
    }
  };

  const queueCacheWrite = (body: string): void => {
    config.execCtx.waitUntil(
      (async () => {
        const bodyBytes = new TextEncoder().encode(body).length;
        if (bodyBytes > DETAIL_CACHE_MAX_VALUE_BYTES) {
          logWorkerEventArgs("api", "error",
            `[detail] cache write skipped stablecoin=${config.stablecoinId} bytes=${bodyBytes} exceeds ${DETAIL_CACHE_MAX_VALUE_BYTES}`,
          );
          await recordCacheWriteFailure("value-too-large", bodyBytes);
          return;
        }
        try {
          const claim = await claimDetailCacheGeneration(config.db, config.stablecoinId);
          const write = await publishDetailCacheGeneration(config.db, cacheKey, body, claim);
          if (!write.written) {
            logWorkerEvent({
              scope: "api",
              level: "info",
              event: "stablecoin_detail.cache_write_superseded",
              route: "stablecoin-detail",
              message: "Skipped detail cache write because a newer refresh owns publication",
              metadata: {
                stablecoinId: config.stablecoinId,
                generation: write.generation,
              },
            });
          }
        } catch (err) {
          logWorkerEventArgs("api", "error",
            `[detail] cache write failed stablecoin=${config.stablecoinId} bytes=${bodyBytes} error=${String(err).slice(0, 300)}`,
          );
          await recordCacheWriteFailure("write-error", bodyBytes);
        }
      })(),
    );
  };

  const loadSupplyHistoryFallback = async (
    reason: string,
    latestTokenDate?: number | null,
  ): Promise<DetailTokens> => {
    const tokens = await fetchSupplyHistoryFallback(config.db, config.stablecoinId, config.pegType);
    if (tokens.length > 0) {
      const latestSuffix = latestTokenDate != null ? ` latest=${latestTokenDate}` : "";
      logWorkerEventArgs("api", "warn",
        `[detail] fallback source=supply_history stablecoin=${config.stablecoinId} reason=${reason} points=${tokens.length}${latestSuffix}`,
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
    return createFreshResponseFromTokens(tokens);
  };

  const createFreshResponseFromBody = (body: string): Response => {
    queueCacheWrite(body);
    return createFreshUpstreamResponse(body);
  };

  const createFreshResponseFromTokens = (tokens: DetailTokens): Response =>
    createFreshResponseFromBody(JSON.stringify({ tokens }));

  const resolveTokensWithSupplyHistoryFallback = async (
    tokens: DetailTokens,
    reasons: { emptyReason: string; staleReason: string },
  ): Promise<DetailTokens> => {
    if (tokens.length === 0) {
      const fallbackTokens = await loadSupplyHistoryFallback(reasons.emptyReason);
      return fallbackTokens.length > 0 ? fallbackTokens : tokens;
    }

    if (!isDetailHistoryFresh(tokens)) {
      const fallbackTokens = await loadSupplyHistoryFallback(
        reasons.staleReason,
        getLatestDetailTokenDate(tokens),
      );
      return fallbackTokens.length > 0 ? fallbackTokens : tokens;
    }

    return tokens;
  };

  return {
    cached: config.cached,
    createFreshResponseFromBody,
    createFreshResponseFromTokens,
    resolveTokensWithSupplyHistoryFallback,
    staleCacheOrError: (status, message) => staleCacheOrError(config.cached, status, message),
    trySupplyHistoryFallback,
  };
}

/** Fallback: build tokens array from D1 supply_history when external APIs have no data. */
async function fetchSupplyHistoryFallback(
  db: D1Database,
  stablecoinId: string,
  pegType: string,
): Promise<Record<string, unknown>[]> {
  const result = await db
    .prepare(
      `SELECT snapshot_date, circulating_usd, price
       FROM supply_history
       WHERE stablecoin_id = ?
       ORDER BY snapshot_date ASC`,
    )
    .bind(stablecoinId)
    .all<{ snapshot_date: number; circulating_usd: number; price: number | null }>();

  return (result.results ?? [])
    .filter((row) => row.circulating_usd > 0)
    .map((row) => ({
      date: row.snapshot_date,
      totalCirculatingUSD: { [pegType]: row.circulating_usd },
      totalCirculating: {
        [pegType]: row.price && row.price > 0 ? row.circulating_usd / row.price : 0,
      },
    }));
}

export function findNearestPrice(
  sortedPrices: { timestamp: number; price: number }[],
  date: number,
): number {
  return binarySearchNearest(sortedPrices, date, (p) => p.timestamp)?.price ?? 0;
}

function dateKeyFromTimestampMs(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function buildPriceMapByDate(
  prices: [number, number][] | undefined,
): Map<string, number> {
  const priceMap = new Map<string, number>();
  if (!prices) return priceMap;

  for (const [ts, price] of prices) {
    if (Number.isFinite(price)) {
      priceMap.set(dateKeyFromTimestampMs(ts), price);
    }
  }
  return priceMap;
}

export function extractDefiLlamaCoinChartPrices(
  payload: unknown,
  geckoId: string,
): DefiLlamaCoinChartPricePoint[] {
  if (!payload || typeof payload !== "object") return [];

  const coins = (payload as DefiLlamaCoinChartResponse).coins;
  const prices = coins?.[`coingecko:${geckoId}`]?.prices;
  if (!Array.isArray(prices)) return [];

  return prices
    .filter((point): point is DefiLlamaCoinChartPricePoint => (
      typeof point?.timestamp === "number"
      && Number.isFinite(point.timestamp)
      && typeof point?.price === "number"
      && Number.isFinite(point.price)
    ))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function getLatestDetailTokenDate(tokens: ReadonlyArray<Record<string, unknown>>): number | null {
  let latestDate: number | null = null;

  for (const token of tokens) {
    const date = token.date;
    if (typeof date !== "number" || !Number.isFinite(date)) continue;
    if (latestDate == null || date > latestDate) latestDate = date;
  }

  return latestDate;
}

function isDetailHistoryFresh(
  tokens: ReadonlyArray<Record<string, unknown>>,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const latestDate = getLatestDetailTokenDate(tokens);
  return latestDate != null && nowSec - latestDate <= DETAIL_HISTORY_MAX_AGE_SECONDS;
}

export function buildTokenRowsFromMarketCaps(
  marketCaps: [number, number][],
  pegType: string,
  priceMap: Map<string, number>,
  resolveMcap?: (mcap: number, price: number) => number,
): Record<string, unknown>[] {
  return marketCaps
    .filter(([, mcap]) => Number.isFinite(mcap) && mcap > 0)
    .map(([ts, mcap]) => {
      const date = Math.floor(ts / 1000);
      const price = priceMap.get(dateKeyFromTimestampMs(ts)) ?? 0;
      const marketCap = resolveMcap ? resolveMcap(mcap, price) : mcap;
      return {
        date,
        totalCirculatingUSD: { [pegType]: marketCap },
        totalCirculating: { [pegType]: price > 0 ? marketCap / price : 0 },
      };
    });
}
