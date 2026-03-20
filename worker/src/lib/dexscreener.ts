/**
 * DexScreener token pools API wrapper.
 * Used as a universal fallback for pool discovery on chains not covered
 * by the main CG/GT/Curve/UniV3 pipeline.
 */
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";
import { DS_CHAIN_MAP } from "@shared/lib/chain-provider-registry";
import { RATE_LIMITS } from "./rate-limit";
import { sleepWithSignal } from "./abort";

export { DS_CHAIN_MAP } from "@shared/lib/chain-provider-registry";

const DS_TOKEN_API = "https://api.dexscreener.com/tokens/v1";

/** Response shape from GET /tokens/v1/{chainId}/{address} */
export interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  priceNative?: string | null;
  volume: { h24: number; h6: number; h1: number; m5: number } | null;
  liquidity: { usd: number; base: number; quote: number } | null;
  pairCreatedAt: number | null;
}

export interface DsTrackedTokenPrice {
  side: "base" | "quote" | null;
  priceUsd: number | null;
}

export interface DsFetchPoolsResult {
  ok: boolean;
  pairs: DsPair[];
}

/**
 * Resolve the tracked token side and, when possible, its USD price.
 *
 * DexScreener `priceUsd` is the base token's USD price. When the tracked token
 * is the quote token, derive its USD price from `priceNative` (base denominated
 * in quote units): quoteUsd = baseUsd / priceNative.
 */
export function getDsTrackedTokenPriceUsd(
  pair: DsPair,
  trackedAddress: string,
): DsTrackedTokenPrice {
  const tracked = trackedAddress.toLowerCase();
  const baseAddress = pair.baseToken.address.toLowerCase();
  const quoteAddress = pair.quoteToken.address.toLowerCase();
  const basePriceUsd = Number.parseFloat(pair.priceUsd ?? "");

  if (tracked === baseAddress) {
    return {
      side: "base",
      priceUsd: Number.isFinite(basePriceUsd) && basePriceUsd > 0 ? basePriceUsd : null,
    };
  }

  if (tracked !== quoteAddress) {
    return { side: null, priceUsd: null };
  }

  const priceNative = Number.parseFloat(pair.priceNative ?? "");
  if (!Number.isFinite(basePriceUsd) || basePriceUsd <= 0 || !Number.isFinite(priceNative) || priceNative <= 0) {
    return { side: "quote", priceUsd: null };
  }

  return {
    side: "quote",
    priceUsd: basePriceUsd / priceNative,
  };
}

/**
 * Fetch all pools for a token on a specific chain from DexScreener.
 * Returns an array of pairs, or empty if the request fails.
 */
export async function fetchDsTokenPools(
  chain: string,
  tokenAddress: string,
  signal?: AbortSignal,
): Promise<DsPair[]> {
  const result = await fetchDsTokenPoolsWithStatus(chain, tokenAddress, signal);
  return result.pairs;
}

export async function fetchDsTokenPoolsWithStatus(
  chain: string,
  tokenAddress: string,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<DsFetchPoolsResult> {
  const dsChain = DS_CHAIN_MAP[chain];
  if (!dsChain) return { ok: false, pairs: [] };

  const url = `${DS_TOKEN_API}/${dsChain}/${tokenAddress}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res?.ok) return { ok: false, pairs: [] };

  try {
    const data = (await res.json()) as DsPair[] | null;
    return { ok: true, pairs: Array.isArray(data) ? data : [] };
  } catch {
    return { ok: false, pairs: [] };
  }
}

/** Rate-limit sleep between DexScreener calls */
export function dsRateLimit(signal?: AbortSignal): Promise<void> {
  return sleepWithSignal(RATE_LIMITS.DEXSCREENER_MS, signal);
}
