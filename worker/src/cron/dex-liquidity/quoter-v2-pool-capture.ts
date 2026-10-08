import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { toErrorMessage } from "@shared/lib/error-utils";
import { encodeFunctionData, parseAbi } from "viem/utils";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { fetchEvmBlockNumber, fetchEvmMulticall3Aggregate3AtBlock, type EvmRpcOptions } from "../../lib/evm-rpc";
import { getDexMeasuredExecutionDeployment, isTickSpacingQuoterV2Profile } from "../measured-execution/registry";
import { createDexMeasuredExecutionRpcBudget, type DexMeasuredExecutionRpcBudget } from "../measured-execution/profiles";
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import { sqrtRatioToSpotPrice } from "./fetch-slipstream";
import { decodeStagedMulticallResult, erc20RecoveryCalls, ERC20_RECOVERY_ABI, mapStagedMulticallResults, rawAmountToDecimal } from "./staged-pool-recovery";
import { buildChainAddressKey } from "./token-resolution";

const POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  // Both V3 and Slipstream have this selector and the same first two words;
  // the protocol-specific trailing observation fields are not identity inputs.
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]);
const SLIPSTREAM_FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns (address pool)"]);
export const QUOTER_V2_CAPTURE_MAX_POOLS = 128;
export const QUOTER_V2_CAPTURE_MAX_REQUESTS = 160;
export const QUOTER_V2_CAPTURE_MAX_WALL_MS = 90_000;
const MULTICALL_BATCH_SIZE = 60;

export interface QuoterV2PoolCaptureCandidate {
  poolAddress: `0x${string}`;
  expectedTokens?: ReadonlySet<string>;
}

/** Discovery is only an address hint; same-block pool reads and getPool own identity. */
export async function captureQuoterV2Pools(input: {
  adapterProfileId: string;
  chain: string;
  candidates: readonly QuoterV2PoolCaptureCandidate[];
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
    const blockNumber = await fetchEvmBlockNumber(input.chain, options);
    if (blockNumber == null) throw new Error("quoter-v2-block-unavailable");
    const slipstream = isTickSpacingQuoterV2Profile(deployment.adapterProfileId);
    const parameterName = slipstream ? "tickSpacing" : "fee";
    const stateCalls = candidates.flatMap((candidate, index) =>
      (["factory", "token0", "token1", parameterName, "slot0"] as const).map((functionName) => ({
        label: `cl-${index}-${functionName}`, target: candidate.poolAddress,
        callData: encodeFunctionData({ abi: POOL_ABI, functionName }),
      })),
    );
    const rawState = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, stateCalls, blockNumber, options);
    if (!rawState) throw new Error("quoter-v2-state-unavailable");
    const state = mapStagedMulticallResults(rawState);
    const decoded = candidates.flatMap((candidate, index) => {
      const prefix = `cl-${index}`;
      const factory = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-factory`), POOL_ABI, "factory"));
      const token0 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token0`), POOL_ABI, "token0"));
      const token1 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token1`), POOL_ABI, "token1"));
      const parameter = decodeStagedMulticallResult<number>(state.get(`${prefix}-${parameterName}`), POOL_ABI, parameterName);
      const slot0 = decodeStagedMulticallResult<readonly [bigint, number]>(state.get(`${prefix}-slot0`), POOL_ABI, "slot0");
      if (factory !== deployment.factoryAddress || !token0 || !token1 || token0 === token1 ||
        (candidate.expectedTokens != null && (candidate.expectedTokens.size !== 2 || !candidate.expectedTokens.has(token0) || !candidate.expectedTokens.has(token1))) ||
        parameter == null || !Number.isInteger(parameter) || parameter <= 0 || parameter > (slipstream ? 8_388_607 : 1_000_000) ||
        !slot0 || slot0[0] <= 0n) return [];
      return [{ candidate, prefix, token0, token1, parameter, sqrtPriceX96: slot0[0] }];
    });
    const factoryAbi = slipstream ? SLIPSTREAM_FACTORY_ABI : V3_FACTORY_ABI;
    const bindingCalls = decoded.flatMap((row) => [
      { label: `${row.prefix}-membership`, target: deployment.factoryAddress,
        callData: encodeFunctionData({ abi: factoryAbi, functionName: "getPool", args: [row.token0, row.token1, row.parameter] }) },
      ...erc20RecoveryCalls(row.prefix, row.candidate.poolAddress, [row.token0, row.token1]),
    ]);
    if (bindingCalls.length === 0) return { ...makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] }), blockNumber };
    const rawBindings = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, bindingCalls, blockNumber, options);
    if (!rawBindings) throw new Error("quoter-v2-binding-unavailable");
    if (rpcBudget.stopReason || input.rpcBudget?.stopReason) throw new Error("quoter-v2-capture-request-budget");
    const bindings = mapStagedMulticallResults(rawBindings);
    const pools: DexApiPool[] = [];
    for (const row of decoded) {
      const membership = canonicalEvmAddress(decodeStagedMulticallResult<string>(bindings.get(`${row.prefix}-membership`), factoryAbi, "getPool"));
      if (membership !== row.candidate.poolAddress) continue;
      const tokenRows = [row.token0, row.token1].flatMap((address, index) => {
        const decimals = decodeStagedMulticallResult<number>(bindings.get(`${row.prefix}-token-${index}-decimals`), ERC20_RECOVERY_ABI, "decimals");
        const balance = decodeStagedMulticallResult<bigint>(bindings.get(`${row.prefix}-token-${index}-balance`), ERC20_RECOVERY_ABI, "balanceOf");
        if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 || balance == null) return [];
        const id = input.chainAddressToId.get(buildChainAddressKey(input.chain, address));
        const reference = id ? input.trackedStablecoinPrices.get(id) : undefined;
        return [{ address, decimals, symbol: id ?? `TOKEN${index}`, balance: rawAmountToDecimal(balance, decimals), reference }];
      });
      if (tokenRows.length !== 2) continue;
      const spot = sqrtRatioToSpotPrice(row.sqrtPriceX96, tokenRows[0]!.decimals, tokenRows[1]!.decimals);
      const price0 = tokenRows[0]!.reference ?? (tokenRows[1]!.reference != null ? spot * tokenRows[1]!.reference : null);
      const price1 = tokenRows[1]!.reference ?? (tokenRows[0]!.reference != null ? tokenRows[0]!.reference / spot : null);
      if (!Number.isFinite(spot) || spot <= 0 || price0 == null || price1 == null || !Number.isFinite(price0) || !Number.isFinite(price1) || price0 <= 0 || price1 <= 0) continue;
      const tvlUsd = tokenRows[0]!.balance * price0 + tokenRows[1]!.balance * price1;
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;
      const source = slipstream ? "aerodrome-slipstream" : deployment.protocol === "pancakeswap" ? "pancakeswap" : "uniswap-v3-shadow";
      pools.push({ source, chain: input.chain, poolAddress: row.candidate.poolAddress,
        poolType: slipstream ? "aerodrome-slipstream-unknown-fee" : deployment.protocol === "pancakeswap" ? "pancakeswap-v3" : "uniswap-v3-shadow",
        tokens: tokenRows.map((token, index) => ({ address: token.address, symbol: token.symbol, decimals: token.decimals, priceUsd: index === 0 ? price0 : price1 })),
        tvlUsd, price: spot, volume24hUsd: null,
        feeRate: slipstream ? null : row.parameter / 1_000_000,
        ...(slipstream ? { tickSpacing: row.parameter } : {}),
        balances: tokenRows.map((token) => token.balance), balancesNormalized: true,
      });
    }
    return { ...makeDexApiFetchResult(pools, { ok: true, degraded: false, errors: [] }), blockNumber };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return makeDexApiFetchResult([], { ok: false, degraded: true, errors: [toErrorMessage(error)] });
  }
}
