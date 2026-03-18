import type { DexApiPool } from "../../lib/dex-api-common";
import { DIRECT_API_POOL_MIN_TVL_USD } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const ORCA_API = "https://api.orca.so/v2/solana/pools";

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
  meta: { next: string | null };
}

export async function fetchOrcaPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];
  let url: string | null = `${ORCA_API}?sortBy=tvl&sortDirection=desc&minTvl=${DIRECT_API_POOL_MIN_TVL_USD}&size=200`;

  while (url) {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });

    if (res.status === 429) {
      console.warn("[fetch-orca] Rate limited (429), stopping pagination");
      break;
    }
    if (!res.ok) {
      console.warn(`[fetch-orca] API returned ${res.status}`);
      break;
    }

    const json = await res.json() as OrcaResponse;
    if (!json.data || json.data.length === 0) break;

    for (const pool of json.data) {
      const tvlUsd = parseFloat(pool.tvlUsdc);
      const price = parseFloat(pool.price);
      const volume = parseFloat(pool.stats?.["24h"]?.volume ?? "0");
      const balA = parseFloat(pool.tokenBalanceA);
      const balB = parseFloat(pool.tokenBalanceB);

      if (!Number.isFinite(tvlUsd) || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;

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
        balances: Number.isFinite(balA) && Number.isFinite(balB) ? [balA, balB] : null,
      });
    }

    // Cursor-based pagination
    url = json.meta?.next ? `${ORCA_API}?next=${encodeURIComponent(json.meta.next)}&size=200` : null;
  }

  if (results.length > 0) {
    console.log(`[fetch-orca] Fetched ${results.length} pools`);
  }
  return results;
}
