import { toErrorMessage } from "@shared/lib/error-utils";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import { getDexMeasuredExecutionDeployment, isTickSpacingQuoterV2Profile } from "../measured-execution/registry";
import { createDexMeasuredExecutionRpcBudget, type DexMeasuredExecutionRpcBudget } from "../measured-execution/profiles";
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import { captureClSourcePools, type ClSourcePoolCandidate } from "./staged-pool-recovery";
export const QUOTER_V2_CAPTURE_MAX_POOLS = 128;
export const QUOTER_V2_CAPTURE_MAX_REQUESTS = 160;
export const QUOTER_V2_CAPTURE_MAX_WALL_MS = 90_000;
const MULTICALL_BATCH_SIZE = 60;


/** Discovery is only an address hint; same-block pool reads and getPool own identity. */
export async function captureQuoterV2Pools(input: {
  adapterProfileId: string;
  chain: string;
  candidates: readonly ClSourcePoolCandidate[];
  chainAddressToId: Map<string, string>;
  trackedStablecoinPrices: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<DexApiFetchResult & { blockNumber?: number }> {
  try {
    const deployment = getDexMeasuredExecutionDeployment(input.adapterProfileId, input.chain);
    if (!deployment) throw new Error("quoter-v2-deployment-unreviewed");
    if (input.candidates.length > QUOTER_V2_CAPTURE_MAX_POOLS) throw new Error("quoter-v2-capture-pool-budget");
    const candidates = input.candidates;
    if (candidates.length === 0) return makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] });
    // Enforce a bound here as well as in the enrichment caller: direct capture
    // callers and endpoint failover must spend the same physical-request limit.
    const rpcBudget = createDexMeasuredExecutionRpcBudget({
      maxRequests: QUOTER_V2_CAPTURE_MAX_REQUESTS,
      deadlineMs: Math.min(input.rpcBudget?.deadlineMs ?? Infinity, Date.now() + QUOTER_V2_CAPTURE_MAX_WALL_MS),
    });
    const options: EvmRpcOptions = {
      chainRpcs: input.chainRpcs, signal: input.signal, timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
      maxRetries: 0, multicallBatchSize: MULTICALL_BATCH_SIZE, deadlineMs: rpcBudget.deadlineMs,
      beforeRequest: () => rpcBudget.tryConsume() && (input.rpcBudget?.tryConsume() ?? true),
    };
    const slipstream = isTickSpacingQuoterV2Profile(deployment.adapterProfileId);
    const capture = await captureClSourcePools({
      chain: input.chain,
      factoryAddress: deployment.factoryAddress,
      parameterName: slipstream ? "tickSpacing" : "fee",
      maxParameter: slipstream ? 8_388_607 : 1_000_000,
      valuation: "pool-implied",
      candidates,
      chainAddressToId: input.chainAddressToId,
      trackedStablecoinPrices: input.trackedStablecoinPrices,
      options,
    });
    if (rpcBudget.stopReason || input.rpcBudget?.stopReason) throw new Error("quoter-v2-capture-request-budget");
    const source = slipstream ? "aerodrome-slipstream" : deployment.protocol === "pancakeswap" ? "pancakeswap" : "uniswap-v3-shadow";
    const pools: DexApiPool[] = capture.pools.map((pool) => ({
      source, chain: input.chain, poolAddress: pool.candidate.poolAddress,
      poolType: slipstream ? "aerodrome-slipstream-unknown-fee" : deployment.protocol === "pancakeswap" ? "pancakeswap-v3" : "uniswap-v3-shadow",
      tokens: pool.tokens, tvlUsd: pool.tvlUsd, price: pool.price, volume24hUsd: null,
      feeRate: slipstream ? null : pool.parameter / 1_000_000,
      ...(slipstream ? { tickSpacing: pool.parameter } : {}),
      balances: pool.balances, balancesNormalized: true,
    }));
    return { ...makeDexApiFetchResult(pools, { ok: true, degraded: false, errors: [] }), blockNumber: capture.blockNumber };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return makeDexApiFetchResult([], { ok: false, degraded: true, errors: [toErrorMessage(error)] });
  }
}
