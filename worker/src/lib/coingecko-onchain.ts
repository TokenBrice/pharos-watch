/**
 * CoinGecko Onchain API helper.
 * Wraps /onchain endpoints for DEX pool discovery.
 * The liquidity cron uses these endpoints for canonical chains that have an
 * explicit CoinGecko network mapping and keeps GeckoTerminal for GT-only chains.
 */
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { cgUrl, cgHeaders } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";
import { fetchPagedTokenPools } from "./paged-token-pools";
import { RATE_LIMITS } from "./rate-limit";
import { sleepWithSignal } from "./abort";
import { cancelResponseBodyQuietly, readResponseTextWithSignal } from "./response-body";
import { CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES, CG_ONCHAIN_TOKEN_POOLS_PAGE_SIZE } from "../cron/dex-liquidity/constants";

/** Check if CoinGecko onchain API is available (API key configured) */
export function isOnchainAvailable(apiKey: string | null): boolean {
  return !!apiKey;
}

// ---------------------------------------------------------------------------
// Response types (matching CoinGecko /onchain response shapes)
// ---------------------------------------------------------------------------

export interface CgPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  reserve_in_usd: string | null;
  h24_volume_usd: string | null;
  pool_fee_percentage: string | null;
  locked_liquidity_percentage: string | null;
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
  ok: boolean;
  pools: CgPool[];
}

const CG_ONCHAIN_LOOKUP_MISS_STATUSES = new Set([400, 404]);
const CG_ONCHAIN_DEFAULT_TIMEOUT_MS = 15_000;

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
 * Returns up to 20 pools per page (paid plans get pagination beyond page 10).
 */
export async function fetchCgTokenPools(
  network: string,
  address: string,
  signal?: AbortSignal,
  apiKey: string | null = null,
  options?: CgFetchOptions,
): Promise<CgPool[]> {
  return (await fetchCgTokenPoolsWithStatus(network, address, signal, apiKey, options)).pools;
}

export async function fetchCgTokenPoolsWithStatus(
  network: string,
  address: string,
  signal?: AbortSignal,
  apiKey: string | null = null,
  options?: CgFetchOptions,
): Promise<CgTokenPoolsResult> {
  let ok = true;
  return fetchPagedTokenPools({
    maxPages: CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES,
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
        } else {
          ok = false;
        }
        return [];
      }
      const json = await readCgOnchainJsonBody<{ data?: unknown }>(
        res,
        options?.timeoutMs ?? CG_ONCHAIN_DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!Array.isArray(json.data)) {
        ok = false;
        return [];
      }
      return json.data as CgPool[];
    },
  }).then((pools) => ({ ok, pools }));
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
