import type { DexApiPool } from "../../lib/dex-api-common";
import { DIRECT_API_POOL_MIN_TVL_USD } from "../../lib/dex-api-common";
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
): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];
  let page = 1;

  while (true) {
    const url = `${RAYDIUM_API}?poolType=${poolType === "concentrated" ? "Concentrated" : "Standard"}&poolSortField=liquidity&sortType=desc&pageSize=1000&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-raydium] ${poolType} page ${page} returned ${res.status}`);
      break;
    }

    const json = await res.json() as { success?: boolean; data?: { data?: RaydiumPool[] } };
    const pools = json.data?.data;
    if (!pools || pools.length === 0) break;

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

  return results;
}

export async function fetchRaydiumPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const [concentrated, standard] = await Promise.allSettled([
    fetchPoolType("concentrated", signal),
    fetchPoolType("standard", signal),
  ]);

  const results: DexApiPool[] = [];
  if (concentrated.status === "fulfilled") results.push(...concentrated.value);
  else console.warn("[fetch-raydium] Concentrated fetch failed:", concentrated.reason);
  if (standard.status === "fulfilled") results.push(...standard.value);
  else console.warn("[fetch-raydium] Standard fetch failed:", standard.reason);

  if (results.length > 0) {
    console.log(`[fetch-raydium] Fetched ${results.length} pools`);
  }
  return results;
}
