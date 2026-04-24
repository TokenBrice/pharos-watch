import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { sleepWithSignal } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { cancelResponseBodyQuietly } from "../../lib/response-body";

const ORCA_API = "https://api.orca.so/v2/solana/pools";
const ORCA_RATE_LIMIT_RETRIES = 3;
const ORCA_RATE_LIMIT_BACKOFF_MS = 1_000;

interface OrcaPool {
  address: string;
  price: string;
  tvlUsdc: string;
  feeRate: number;
  tokenA: { address: string; symbol: string; decimals: number };
  tokenB: { address: string; symbol: string; decimals: number };
  tokenBalanceA: string;
  tokenBalanceB: string;
  stats: { "24h"?: { volume?: string } };
}

interface OrcaResponse {
  data: OrcaPool[];
  meta?: {
    next?: string | null;
    cursor?: {
      next?: string | null;
      previous?: string | null;
    } | null;
  };
}

export async function fetchOrcaPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let successfulPages = 0;
  let degraded = false;
  let url: string | null = `${ORCA_API}?sortBy=tvl&sortDirection=desc&minTvl=${DIRECT_API_POOL_MIN_TVL_USD}&size=200`;
  const seenCursors = new Set<string>();

  while (url) {
    let res: Response | null = null;
    let pageError: string | null = null;

    for (let attempt = 0; attempt <= ORCA_RATE_LIMIT_RETRIES; attempt++) {
      try {
        res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
      } catch (err) {
        pageError = err instanceof Error ? err.message : String(err);
        break;
      }

      if (res.status !== 429) break;

      degraded = true;
      if (attempt === ORCA_RATE_LIMIT_RETRIES) {
        pageError = "rate limited (429) after retries";
        await cancelResponseBodyQuietly(res);
        break;
      }
      await cancelResponseBodyQuietly(res);
      await sleepWithSignal(ORCA_RATE_LIMIT_BACKOFF_MS * 2 ** attempt, signal);
    }

    if (!res) {
      errors.push(pageError ?? "request failed");
      break;
    }

    if (pageError) {
      errors.push(pageError);
      break;
    }

    if (!res.ok) {
      errors.push(`API returned ${res.status}`);
      await cancelResponseBodyQuietly(res);
      break;
    }

    const json = await res.json() as OrcaResponse;
    if (!Array.isArray(json.data)) {
      errors.push("returned malformed body");
      break;
    }

    successfulPages++;
    if (json.data.length === 0) break;

    let pageHasEligiblePool = false;
    for (const pool of json.data) {
      const tvlUsd = parseFloat(pool.tvlUsdc);
      const price = parseFloat(pool.price);
      const volume = parseFloat(pool.stats?.["24h"]?.volume ?? "0");
      const balA = parseFloat(pool.tokenBalanceA);
      const balB = parseFloat(pool.tokenBalanceB);
      const normalizedBalA = Number.isFinite(balA) ? balA / 10 ** pool.tokenA.decimals : NaN;
      const normalizedBalB = Number.isFinite(balB) ? balB / 10 ** pool.tokenB.decimals : NaN;

      if (!Number.isFinite(tvlUsd) || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;
      pageHasEligiblePool = true;

      results.push({
        source: "orca",
        chain: "solana",
        poolAddress: pool.address,
        poolType: "orca-whirlpool",
        tokens: [
          { address: pool.tokenA.address, symbol: pool.tokenA.symbol, decimals: pool.tokenA.decimals },
          { address: pool.tokenB.address, symbol: pool.tokenB.symbol, decimals: pool.tokenB.decimals },
        ],
        price: Number.isFinite(price) && price > 0 ? price : null,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume) ? volume : 0,
        // Orca feeRate is in hundredths of a basis point (100 = 1bp = 0.0001)
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate / 1_000_000 : null,
        balances: Number.isFinite(normalizedBalA) && Number.isFinite(normalizedBalB)
          ? [normalizedBalA, normalizedBalB]
          : null,
      });
    }

    if (!pageHasEligiblePool) break;

    // Cursor-based pagination
    const nextCursor = json.meta?.cursor?.next ?? json.meta?.next ?? null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      degraded = true;
      errors.push("cursor loop detected");
      break;
    }
    if (nextCursor) seenCursors.add(nextCursor);
    url = nextCursor ? `${ORCA_API}?next=${encodeURIComponent(nextCursor)}&size=200` : null;
  }

  if (results.length > 0) {
    console.log(`[fetch-orca] Fetched ${results.length} pools`);
  }
  for (const error of errors) {
    console.warn("[fetch-orca]", error);
  }
  return makeDexApiFetchResult(results, {
    ok: successfulPages > 0,
    degraded: degraded || errors.length > 0,
    errors,
  });
}
