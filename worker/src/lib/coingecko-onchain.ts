/**
 * CoinGecko Onchain API helper.
 * Wraps /onchain endpoints for DEX pool discovery.
 * Falls through to GeckoTerminal free API when no CG API key is configured.
 */
import { cgUrl, cgHeaders } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";
import { CG_CHAIN_MAP, CG_CHAIN_REVERSE } from "./chain-registry";
import { RATE_LIMITS } from "./rate-limits";
import { sleepWithSignal } from "./abort";

// Re-export for downstream consumers
export { CG_CHAIN_MAP, CG_CHAIN_REVERSE };

/** Check if CoinGecko onchain API is available (API key configured) */
let onchainAvailable = false;
export function initOnchainAvailability(apiKey: string | undefined): void {
  onchainAvailable = !!apiKey?.trim();
}
export function isOnchainAvailable(): boolean {
  return onchainAvailable;
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

export interface CgTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

export interface CgToken {
  id: string;
  type: string;
  attributes: CgTokenAttributes;
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
): Promise<CgPool[]> {
  const url = cgUrl(`/onchain/networks/${network}/tokens/${address}/pools?include=base_token,quote_token&page=1`);
  const res = await fetchWithRetry(url, {
    headers: cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
    signal,
  }, 1); // 1 retry max to keep wall time bounded
  if (!res?.ok) return [];
  const json = (await res.json()) as { data?: unknown };
  return Array.isArray(json.data) ? (json.data as CgPool[]) : [];
}

/**
 * Fetch multiple tokens by addresses (batch).
 * GET /onchain/networks/{network}/tokens/multi/{addresses}
 * Addresses comma-separated, max 30 per request.
 */
export async function fetchCgTokensBatch(
  network: string,
  addresses: string[],
  signal?: AbortSignal,
): Promise<CgToken[]> {
  if (addresses.length === 0) return [];
  const joined = addresses.join(",");
  const url = cgUrl(`/onchain/networks/${network}/tokens/multi/${joined}`);
  const res = await fetchWithRetry(url, {
    headers: cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
    signal,
  }, 1);
  if (!res?.ok) return [];
  const json = (await res.json()) as { data?: unknown };
  return Array.isArray(json.data) ? (json.data as CgToken[]) : [];
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
