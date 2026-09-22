/**
 * CoinGecko Onchain API helper.
 * Wraps /onchain endpoints for DEX pool discovery.
 * The liquidity cron uses these endpoints for canonical chains that have an
 * explicit CoinGecko network mapping and keeps GeckoTerminal for GT-only chains.
 */
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import { cgUrl, cgHeaders } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";
import { fetchPagedTokenPools } from "./paged-token-pools";
import { RATE_LIMITS } from "./rate-limit";
import { sleepWithSignal } from "./abort";
import { cancelResponseBodyQuietly, readResponseTextWithSignal } from "./response-body";
import { CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES, CG_ONCHAIN_TOKEN_POOLS_PAGE_SIZE } from "../cron/dex-liquidity/constants";

// ---------------------------------------------------------------------------
// Response types (matching CoinGecko /onchain response shapes)
// ---------------------------------------------------------------------------

export interface CgPoolAttributes {
  address: string;
  name: string;
  pool_created_at?: string | null;
  base_token_price_usd?: string | null;
  quote_token_price_usd?: string | null;
  reserve_in_usd?: string | null;
  h24_volume_usd?: string | null;
  pool_fee_percentage?: string | null;
  locked_liquidity_percentage?: string | null;
  // GT-compat fields (CG onchain returns the same shape)
  volume_usd?: { h24: string | null } | null;
}

export interface CgPoolRelationships {
  base_token: { data: { id: string; type: string } };
  quote_token: { data: { id: string; type: string } };
  dex: { data: { id: string; type: string } };
}

export interface CgPool {
  id: string;
  type: string;
  attributes: CgPoolAttributes;
  relationships: CgPoolRelationships;
}

export interface CgFetchOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

export interface CgTokenPoolsResult {
  transportOk: boolean;
  schemaDegraded: boolean;
  /** Run-scoped pagination contiguity: a page shorter than the page size was read. */
  complete: boolean;
  pools: CgPool[];
}

const CG_ONCHAIN_LOOKUP_MISS_STATUSES = new Set([400, 404]);
const CG_ONCHAIN_DEFAULT_TIMEOUT_MS = 15_000;
/** Documented plan boundary: pages past this need a higher CoinGecko tier. */
const CG_ONCHAIN_PLAN_MAX_PAGE = 10;

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

function isCgPoolAttributes(value: unknown): value is CgPoolAttributes {
  if (!isRecord(value)) return false;
  return (
    typeof value.address === "string" &&
    typeof value.name === "string" &&
    isOptionalStringOrNull(value.pool_created_at) &&
    isOptionalStringOrNull(value.base_token_price_usd) &&
    isOptionalStringOrNull(value.quote_token_price_usd) &&
    isOptionalStringOrNull(value.reserve_in_usd) &&
    isOptionalStringOrNull(value.h24_volume_usd) &&
    isOptionalStringOrNull(value.pool_fee_percentage) &&
    isOptionalStringOrNull(value.locked_liquidity_percentage) &&
    (value.volume_usd === undefined ||
      value.volume_usd === null ||
      (isRecord(value.volume_usd) && isStringOrNull(value.volume_usd.h24)))
  );
}

function isCgPoolRelationship(value: unknown): value is { data: { id: string; type: string } } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    typeof value.data.id === "string" &&
    typeof value.data.type === "string"
  );
}

function isCgPool(value: unknown): value is CgPool {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isCgPoolAttributes(value.attributes) &&
    isRecord(value.relationships) &&
    isCgPoolRelationship(value.relationships.base_token) &&
    isCgPoolRelationship(value.relationships.quote_token) &&
    isCgPoolRelationship(value.relationships.dex)
  );
}

async function readCgOnchainJsonBody<T>(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new DOMException(`response body timed out after ${timeoutMs}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return JSON.parse(await readResponseTextWithSignal(response, timeout.signal)) as T;
  } finally {
    timeout.dispose();
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Rate-limit helper: wait between requests */
export async function onchainRateLimit(requestCount: number, signal?: AbortSignal): Promise<void> {
  if (requestCount > 0) {
    await sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
  }
}

/**
 * Fetch top pools for a token by contract address.
 * GET /onchain/networks/{network}/tokens/{address}/pools
 * Returns up to 20 pools per page. `complete` is the run-scoped contiguity
 * claim; a capped or failed scan never certifies the token's pool set.
 */
export async function fetchCgTokenPoolsWithStatus(
  network: string,
  address: string,
  signal?: AbortSignal,
  apiKey: string | null = null,
  options?: CgFetchOptions,
): Promise<CgTokenPoolsResult> {
  let transportOk = true;
  let schemaDegraded = false;
  const paged = await fetchPagedTokenPools<unknown>({
    // The documented plan boundary is page 10, but a live paid key still served
    // rows on page 11: neither bound is an inventory end, so a scan that
    // reaches one returns `complete: false`.
    maxPages: Math.min(CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES, CG_ONCHAIN_PLAN_MAX_PAGE),
    pageSize: CG_ONCHAIN_TOKEN_POOLS_PAGE_SIZE,
    fetchPage: async (page) => {
      const url = cgUrl(
        `/onchain/networks/${network}/tokens/${address}/pools?include=base_token,quote_token&page=${page}`,
        apiKey,
      );
      const res = await fetchWithRetry(url, {
        headers: cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }, apiKey),
        signal,
      }, options?.maxRetries ?? 1, {
        timeoutMs: options?.timeoutMs,
        passthroughStatuses: [...CG_ONCHAIN_LOOKUP_MISS_STATUSES],
      });
      if (!res?.ok) {
        if (res && CG_ONCHAIN_LOOKUP_MISS_STATUSES.has(res.status)) {
          await cancelResponseBodyQuietly(res);
          return [];
        }
        transportOk = false;
        return { pageFailed: true };
      }
      const json = await readCgOnchainJsonBody<{ data?: unknown }>(
        res,
        options?.timeoutMs ?? CG_ONCHAIN_DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!Array.isArray(json.data)) {
        schemaDegraded = true;
        return { pageFailed: true };
      }
      return json.data;
    },
  });
  const pools = paged.rows.filter((pool): pool is CgPool => {
    const valid = isCgPool(pool);
    if (!valid) schemaDegraded = true;
    return valid;
  });
  return { transportOk, schemaDegraded, complete: paged.complete, pools };
}

/**
 * Parse a CoinGecko pool's volume. The CG Pro API uses flat `h24_volume_usd`,
 * while the GT-compat format uses nested `volume_usd.h24`. Handle both.
 */
export function parseCgPoolVolume(attrs: CgPoolAttributes): number {
  // Try CG Pro flat field first
  if (attrs.h24_volume_usd != null) {
    const v = parseFloat(attrs.h24_volume_usd);
    if (!isNaN(v) && v > 0) return v;
  }
  // Fallback to GT-compat nested field
  if (attrs.volume_usd?.h24 != null) {
    const v = parseFloat(attrs.volume_usd.h24);
    if (!isNaN(v) && v > 0) return v;
  }
  return 0;
}
