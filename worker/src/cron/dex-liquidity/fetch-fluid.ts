import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const FLUID_API_BASE = "https://api.fluid.instadapp.io/v2";

/** Fluid API chain IDs mapped to our internal chain keys */
const FLUID_CHAINS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  bsc: 56,
  plasma: 9745,
};

interface FluidTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  pool_id: string;
  liquidity_in_usd: string;
}

export async function fetchFluidPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let successfulChains = 0;

  const fetches = Object.entries(FLUID_CHAINS).map(async ([chain, chainId]) => {
    const url = `${FLUID_API_BASE}/${chainId}/dexes/stats/tickers`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!res.ok) {
      throw new Error(`${chain} returned ${res.status}`);
    }
    const tickers = await res.json() as unknown;
    if (!Array.isArray(tickers)) {
      throw new Error(`${chain} returned non-array body`);
    }

    return (tickers as FluidTicker[]).map((t): DexApiPool | null => {
      const tvlUsd = parseFloat(t.liquidity_in_usd);
      const price = parseFloat(t.last_price);
      const baseVol = parseFloat(t.base_volume);
      const targetVol = parseFloat(t.target_volume);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

      return {
        source: "fluid",
        chain,
        poolAddress: t.pool_id,
        poolType: "fluid-dex",
        tokens: [
          { address: t.base_currency, symbol: "", decimals: 0 },
          { address: t.target_currency, symbol: "", decimals: 0 },
        ],
        price: Number.isFinite(price) && price > 0 ? price : null,
        tvlUsd,
        volume24hUsd:
          (Number.isFinite(baseVol) ? baseVol : 0) +
          (Number.isFinite(targetVol) ? targetVol : 0),
        feeRate: null,
        balances: null,
        tokenVolumes24h: [Number.isFinite(baseVol) ? baseVol : 0, Number.isFinite(targetVol) ? targetVol : 0],
      };
    }).filter((p): p is DexApiPool => p !== null);
  });

  const settled = await Promise.allSettled(fetches);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      successfulChains++;
      results.push(...result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(reason);
      console.warn("[fetch-fluid] Chain fetch failed:", reason);
    }
  }

  if (results.length > 0) {
    console.log(`[fetch-fluid] Fetched ${results.length} pools across ${Object.keys(FLUID_CHAINS).length} chains`);
  }

  return makeDexApiFetchResult(results, {
    ok: successfulChains > 0,
    degraded: errors.length > 0,
    errors,
  });
}
