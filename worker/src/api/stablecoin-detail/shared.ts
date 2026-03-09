import { CACHE_PROFILES } from "../../lib/constants";
import { binarySearchNearest } from "../../lib/binary-search";
import { errorResponse } from "../../lib/api-utils";

export const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes
export const DETAIL_UPSTREAM_TIMEOUT_MS = 12_000;
export const DETAIL_UPSTREAM_MAX_RETRIES = 2;

export type DetailCacheEntry = { value: string; updatedAt: number } | null;

export function logUpstreamFailure(
  source: string,
  stablecoinId: string,
  status: number | "no-response",
): void {
  console.warn(`[detail] upstream failure source=${source} stablecoin=${stablecoinId} status=${status}`);
}

export function logUpstreamException(
  source: string,
  stablecoinId: string,
  err: unknown,
): void {
  console.error(
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
    `public, s-maxage=${CACHE_TTL_SECONDS - ageSeconds}, max-age=10`,
  );
}

export function createFreshUpstreamResponse(body: string): Response {
  return createJsonResponse(body, `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=10`);
}

function createStaleCacheResponse(cached: DetailCacheEntry): Response | null {
  if (!cached) return null;
  return createJsonResponse(cached.value, CACHE_PROFILES.realtime);
}

export function staleCacheOrError(
  cached: DetailCacheEntry,
  status: number,
  message: string,
): Response {
  return createStaleCacheResponse(cached) ?? errorResponse(status, message);
}

/** Fallback: build tokens array from D1 supply_history when external APIs have no data. */
export async function fetchSupplyHistoryFallback(
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
    priceMap.set(dateKeyFromTimestampMs(ts), price);
  }
  return priceMap;
}

export function buildTokenRowsFromMarketCaps(
  marketCaps: [number, number][],
  pegType: string,
  priceMap: Map<string, number>,
  resolveMcap?: (mcap: number, price: number) => number,
): Record<string, unknown>[] {
  return marketCaps
    .filter(([, mcap]) => mcap > 0)
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
