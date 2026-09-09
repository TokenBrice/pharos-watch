import type { AdapterContext } from "./types";
import { fetchJsonWithRetry } from "./helpers";

/**
 * Bounded TzKT (Tezos indexer) REST transport for pinned-level reserve reads.
 *
 * Every helper pins the same level: the caller fetches the head once
 * (`fetchTzktHead`), then passes that level to storage and bigmap reads so a
 * snapshot is internally consistent even when the chain advances mid-attempt.
 * All reads are single bounded calls — bigmap enumeration is capped at
 * `maxPages` pages and fails closed (throws) if a bigmap has more active keys
 * than fit, so an attempt can never paginate without limit.
 */

export const TZKT_REST_ENDPOINT = "https://api.tzkt.io";

/** Upper bound of keys a single TzKT keys page can return. */
export const TZKT_BIGMAP_PAGE_LIMIT = 10_000;

const REQUEST_TIMEOUT_MS = 12_000;

export interface TzktHead {
  /** Pinned Tezos block level. */
  level: number;
  /** Pinned block timestamp (ISO-8601). */
  timestamp: string;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function parseHead(payload: unknown, label: string): TzktHead {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`tzkt: ${label} response is not an object`);
  }
  const record = payload as Record<string, unknown>;
  const level = record.level;
  const timestamp = record.timestamp;
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level <= 0) {
    throw new Error(`tzkt: ${label} level is not a positive safe integer`);
  }
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`tzkt: ${label} timestamp is not a parseable ISO string`);
  }
  return { level, timestamp };
}

/** Reads the current chain head and returns its pinned `{ level, timestamp }`. */
export async function fetchTzktHead(
  baseUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<TzktHead> {
  const payload = await fetchJsonWithRetry<unknown>(endpoint(baseUrl, "/v1/head"), signal, REQUEST_TIMEOUT_MS, ctx);
  return parseHead(payload, "head");
}

/** Reads a contract's storage as of the pinned level. */
export async function fetchTzktContractStorage(
  baseUrl: string,
  address: string,
  level: number,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<unknown> {
  return fetchJsonWithRetry<unknown>(
    endpoint(baseUrl, `/v1/contracts/${encodeURIComponent(address)}/storage?level=${level}`),
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
}

/**
 * Enumerates a bigmap's active keys as of the pinned level, bounded to
 * `maxPages` pages. Throws when the bigmap holds more active keys than the
 * bound so an attempt can never silently truncate the census.
 */
export async function fetchTzktBigmapKeys(
  baseUrl: string,
  bigmapId: number,
  level: number,
  signal: AbortSignal,
  ctx?: AdapterContext,
  maxPages = 2,
): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
  if (!Number.isSafeInteger(bigmapId) || bigmapId < 0) {
    throw new Error(`tzkt: bigmap id is not a non-negative safe integer: ${String(bigmapId)}`);
  }
  const keys: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchJsonWithRetry<unknown>(
      endpoint(
        baseUrl,
        `/v1/bigmaps/${bigmapId}/keys?active=true&level=${level}&limit=${TZKT_BIGMAP_PAGE_LIMIT}&offset=${page * TZKT_BIGMAP_PAGE_LIMIT}`,
      ),
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
    );
    if (!Array.isArray(payload)) {
      throw new Error(`tzkt: bigmap ${bigmapId} keys response is not an array`);
    }
    for (const entry of payload) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.key !== "string") {
        throw new Error(`tzkt: bigmap ${bigmapId} key row has a non-string key`);
      }
      if (typeof record.value !== "object" || record.value === null) {
        throw new Error(`tzkt: bigmap ${bigmapId} key ${record.key} has a non-object value`);
      }
      keys.push({ key: record.key, value: record.value as Record<string, unknown> });
    }
    if (payload.length < TZKT_BIGMAP_PAGE_LIMIT) return keys;
  }
  throw new Error(`tzkt: bigmap ${bigmapId} has more than ${maxPages * TZKT_BIGMAP_PAGE_LIMIT} active keys; census exceeds the bounded read limit`);
}

/** Reads one bigmap key's value as of the pinned level. */
export async function fetchTzktBigmapValue(
  baseUrl: string,
  bigmapId: number,
  key: string,
  level: number,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<unknown> {
  const payload = await fetchJsonWithRetry<unknown>(
    endpoint(
      baseUrl,
      `/v1/bigmaps/${bigmapId}/keys?key=${encodeURIComponent(key)}&active=true&level=${level}`,
    ),
    signal,
    REQUEST_TIMEOUT_MS,
    ctx,
  );
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`tzkt: bigmap ${bigmapId} key ${key} did not resolve to exactly one active row`);
  }
  const entry = payload[0] as Record<string, unknown> | undefined;
  if (entry == null) {
    throw new Error(`tzkt: bigmap ${bigmapId} key ${key} row is not an object`);
  }
  return entry.value;
}
