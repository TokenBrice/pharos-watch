/**
 * DexScreener token pools API wrapper.
 * Used as a universal fallback for pool discovery on chains not covered
 * by the main CG/GT/Curve/UniV3 pipeline.
 */
import { fetchWithRetry } from "./fetch-retry";
import { DS_CHAIN_MAP } from "@shared/lib/chains";
import { RATE_LIMITS } from "./rate-limit";
import { sleepWithSignal } from "./abort";

export { DS_CHAIN_MAP } from "@shared/lib/chains";

const DS_TOKEN_API = "https://api.dexscreener.com/tokens/v1";
const DEXSCREENER_BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEXSCREENER_API_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://dexscreener.com",
  Referer: "https://dexscreener.com/",
  "User-Agent": DEXSCREENER_BROWSER_USER_AGENT,
};

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
  status?: number;
  contentType?: string;
  error?: string;
}

function isDsPair(value: unknown): value is DsPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<DsPair>;
  return typeof pair.chainId === "string"
    && typeof pair.dexId === "string"
    && typeof pair.pairAddress === "string"
    && !!pair.baseToken
    && typeof pair.baseToken.address === "string"
    && typeof pair.baseToken.symbol === "string"
    && !!pair.quoteToken
    && typeof pair.quoteToken.address === "string"
    && typeof pair.quoteToken.symbol === "string";
}

function parseDexScreenerTokenPoolsResponse(data: unknown): DsPair[] | null {
  if (Array.isArray(data)) {
    return data.filter(isDsPair);
  }
  if (
    data != null &&
    typeof data === "object" &&
    Array.isArray((data as { pairs?: unknown }).pairs)
  ) {
    return (data as { pairs: unknown[] }).pairs.filter(isDsPair);
  }
  return null;
}

function summarizeBody(raw: string, limit = 160): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function describeNonOkResponse(url: string, res: Response): Promise<DsFetchPoolsResult> {
  const contentType = res.headers.get("content-type") ?? "unknown";
  let snippet = "";
  try {
    snippet = summarizeBody(await res.text());
  } catch {
    snippet = "";
  }
  return {
    ok: false,
    pairs: [],
    status: res.status,
    contentType,
    error: `HTTP ${res.status} for ${url}${snippet ? `; body starts with: ${snippet}` : ""}`,
  };
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
 * Returns `{ ok, pairs }` so callers can distinguish "no pools" (200 with empty
 * array) from "fetch failed" (timeout, non-OK status, parse error) for circuit
 * breaker accounting.
 */
export async function fetchDsTokenPoolsWithStatus(
  chain: string,
  tokenAddress: string,
  signal?: AbortSignal,
  timeoutMs = 10_000,
  maxRetries = 2,
): Promise<DsFetchPoolsResult> {
  const dsChain = DS_CHAIN_MAP[chain];
  if (!dsChain) return { ok: false, pairs: [] };

  const url = `${DS_TOKEN_API}/${dsChain}/${tokenAddress}`;
  // Per-request timeout is handled by fetchWithRetry; adding a second outer
  // timeout here caused retries to be silently killed (the outer fired during
  // retry waits, producing an AbortError that callers swallowed as a failure).
  const res = await fetchWithRetry(url, {
    headers: DEXSCREENER_API_HEADERS,
    signal,
  }, maxRetries, { timeoutMs, returnFinalResponse: true });
  if (!res) return { ok: false, pairs: [], error: `Fetch failed for ${url}` };
  if (!res.ok) return describeNonOkResponse(url, res);

  const contentType = res.headers.get("content-type") ?? "unknown";
  const status = res.status;

  try {
    const raw = await res.text();
    const data = JSON.parse(raw) as unknown;
    const parsedPairs = parseDexScreenerTokenPoolsResponse(data);
    if (parsedPairs == null) {
      return {
        ok: false,
        pairs: [],
        status,
        contentType,
        error: "DexScreener payload schema changed: expected array or object.pairs[]",
      };
    }

    const rawCount = Array.isArray(data)
      ? data.length
      : Array.isArray((data as { pairs?: unknown }).pairs)
        ? (data as { pairs: unknown[] }).pairs.length
        : 0;
    if (rawCount > 0 && parsedPairs.length === 0) {
      return {
        ok: false,
        pairs: [],
        status,
        contentType,
        error: "DexScreener payload contained no valid pair rows",
      };
    }
    return { ok: true, pairs: parsedPairs };
  } catch (error) {
    return {
      ok: false,
      pairs: [],
      status,
      contentType,
      error: `DexScreener JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Rate-limit sleep between DexScreener calls */
export function dsRateLimit(signal?: AbortSignal): Promise<void> {
  return sleepWithSignal(RATE_LIMITS.DEXSCREENER_MS, signal);
}
