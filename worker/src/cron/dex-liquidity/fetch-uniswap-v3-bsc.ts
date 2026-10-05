import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { DIRECT_API_MAX_POOL_TVL_USD, DIRECT_API_POOL_MIN_TVL_USD, makeDexApiFetchResult, type DexApiFetchResult } from "../../lib/dex-api-common";
import { loadStagedPoolRecoveryRows } from "./staged-pool-recovery";
import { captureQuoterV2Pools } from "./quoter-v2-pool-capture";

/** Bounded discovery recovery remains target-only and shadow on BSC. */
export async function fetchUniswapV3BscShadowPools(input: {
  db: D1Database;
  chainAddressToId: Map<string, string>;
  trackedStablecoinPrices: Map<string, number>;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): Promise<DexApiFetchResult> {
  try {
    const rows = await loadStagedPoolRecoveryRows(input.db, { chain: "bsc", dexId: "uniswap-bsc" });
    const candidates = rows.flatMap((row) => {
      const poolAddress = canonicalEvmAddress(row.pool_id.startsWith("bsc:") ? row.pool_id.slice(4) : null);
      const token0 = canonicalEvmAddress(row.base_token);
      const token1 = canonicalEvmAddress(row.quote_token);
      return poolAddress && token0 && token1 && token0 !== token1
        ? [{ poolAddress, expectedTokens: new Set([token0, token1]) }]
        : [];
    });
    const result = await captureQuoterV2Pools({ ...input, candidates, chain: "bsc", adapterProfileId: "uniswap-v3-quoter-v2" });
    return { ...result, pools: result.pools.filter((pool) => pool.tvlUsd >= DIRECT_API_POOL_MIN_TVL_USD && pool.tvlUsd <= DIRECT_API_MAX_POOL_TVL_USD) };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return makeDexApiFetchResult([], { ok: false, degraded: true, errors: [toErrorMessage(error)] });
  }
}
