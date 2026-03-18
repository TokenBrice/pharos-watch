import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const RAYDIUM_API = "https://api-v3.raydium.io/pools/info/list";

interface RaydiumPool {
  type: string;
  id: string;
  mintA: { address: string; symbol: string; decimals: number };
  mintB: { address: string; symbol: string; decimals: number };
  price: number;
  tvl: number;
  mintAmountA: number;
  mintAmountB: number;
  feeRate: number;
  day: { volume: number };
}

async function fetchPoolType(
  poolType: "concentrated" | "standard",
  signal?: AbortSignal,
): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let successfulPages = 0;
  let page = 1;

  while (true) {
    const url = `${RAYDIUM_API}?poolType=${poolType}&poolSortField=liquidity&sortType=desc&pageSize=1000&page=${page}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${poolType} page ${page} request failed: ${message}`);
      break;
    }

    if (!res.ok) {
      errors.push(`${poolType} page ${page} returned ${res.status}`);
      break;
    }

    const json = await res.json() as { success?: boolean; msg?: string; data?: { data?: RaydiumPool[] } };
    if (json.success === false) {
      errors.push(`${poolType} page ${page} API error: ${json.msg ?? "unsuccessful response"}`);
      break;
    }

    const pools = json.data?.data;
    if (!Array.isArray(pools)) {
      errors.push(`${poolType} page ${page} returned malformed body`);
      break;
    }

    successfulPages++;
    if (pools.length === 0) break;

    let belowThreshold = false;
    for (const pool of pools) {
      if (!Number.isFinite(pool.tvl) || pool.tvl < DIRECT_API_POOL_MIN_TVL_USD) {
        belowThreshold = true;
        break;
      }

      const isConcentrated = poolType === "concentrated";
      results.push({
        source: "raydium",
        chain: "solana",
        poolAddress: pool.id,
        poolType: isConcentrated ? "raydium-clmm" : "raydium-amm",
        tokens: [
          { address: pool.mintA.address, symbol: pool.mintA.symbol, decimals: pool.mintA.decimals },
          { address: pool.mintB.address, symbol: pool.mintB.symbol, decimals: pool.mintB.decimals },
        ],
        price: Number.isFinite(pool.price) && pool.price > 0 ? pool.price : null,
        tvlUsd: pool.tvl,
        volume24hUsd: Number.isFinite(pool.day?.volume) ? pool.day.volume : 0,
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate : null,
        balances: [pool.mintAmountA, pool.mintAmountB].every(Number.isFinite)
          ? [pool.mintAmountA, pool.mintAmountB]
          : null,
      });
    }

    if (belowThreshold || pools.length < 1000) break;
    page++;
  }

  for (const error of errors) {
    console.warn("[fetch-raydium]", error);
  }
  return makeDexApiFetchResult(results, {
    ok: successfulPages > 0,
    degraded: errors.length > 0,
    errors,
  });
}

export async function fetchRaydiumPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const [concentrated, standard] = await Promise.allSettled([
    fetchPoolType("concentrated", signal),
    fetchPoolType("standard", signal),
  ]);

  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let ok = false;
  let degraded = false;

  if (concentrated.status === "fulfilled") {
    results.push(...concentrated.value);
    ok = ok || concentrated.value.ok;
    degraded = degraded || concentrated.value.degraded;
    errors.push(...concentrated.value.errors);
  } else {
    const message = concentrated.reason instanceof Error ? concentrated.reason.message : String(concentrated.reason);
    errors.push(`concentrated request failed: ${message}`);
    degraded = true;
  }

  if (standard.status === "fulfilled") {
    results.push(...standard.value);
    ok = ok || standard.value.ok;
    degraded = degraded || standard.value.degraded;
    errors.push(...standard.value.errors);
  } else {
    const message = standard.reason instanceof Error ? standard.reason.message : String(standard.reason);
    errors.push(`standard request failed: ${message}`);
    degraded = true;
  }

  if (results.length > 0) {
    console.log(`[fetch-raydium] Fetched ${results.length} pools`);
  }
  return makeDexApiFetchResult(results, { ok, degraded, errors });
}
