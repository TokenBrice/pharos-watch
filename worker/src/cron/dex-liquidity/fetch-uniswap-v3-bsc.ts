import { toErrorMessage } from "@shared/lib/error-utils";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { encodeFunctionData, parseAbi } from "viem/utils";

import {
  DIRECT_API_MAX_POOL_TVL_USD,
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockNumber,
  fetchEvmMulticall3Aggregate3AtBlock,
} from "../../lib/evm-rpc";
import { getDexMeasuredExecutionDeployment } from "../measured-execution/registry";
import { buildChainAddressKey } from "./token-resolution";
import {
  decodeStagedMulticallResult,
  erc20RecoveryCalls,
  ERC20_RECOVERY_ABI,
  loadStagedPoolRecoveryRows,
  mapStagedMulticallResults,
  rawAmountToDecimal,
} from "./staged-pool-recovery";
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import { sqrtRatioToSpotPrice } from "./fetch-slipstream";

const CHAIN = "bsc";
const STAGING_DEX_ID = "uniswap-bsc";
const MULTICALL_BATCH_SIZE = 60;
const successfulResult = (pools: DexApiPool[]): DexApiFetchResult =>
  makeDexApiFetchResult(pools, { ok: true, degraded: false, errors: [] });
const POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
]);
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);

interface Candidate {
  poolAddress: `0x${string}`;
  expectedTokens: Set<string>;
}

async function loadCandidates(db: D1Database): Promise<Candidate[]> {
  const rows = await loadStagedPoolRecoveryRows(db, { chain: CHAIN, dexId: STAGING_DEX_ID });
  return rows.flatMap((row) => {
    const poolAddress = canonicalEvmAddress(
      row.pool_id.startsWith(`${CHAIN}:`) ? row.pool_id.slice(CHAIN.length + 1) : null,
    );
    const baseToken = canonicalEvmAddress(row.base_token);
    const quoteToken = canonicalEvmAddress(row.quote_token);
    if (!poolAddress || !baseToken || !quoteToken || baseToken === quoteToken) return [];
    return [{ poolAddress, expectedTokens: new Set([baseToken, quoteToken]) }];
  });
}

export async function fetchUniswapV3BscShadowPools(input: {
  db: D1Database;
  chainAddressToId: Map<string, string>;
  trackedStablecoinPrices: Map<string, number>;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): Promise<DexApiFetchResult> {
  try {
    const deployment = getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", CHAIN);
    if (!deployment) throw new Error("uniswap-v3-bsc-deployment-unavailable");
    const candidates = await loadCandidates(input.db);
    if (candidates.length === 0) return successfulResult([]);

    const blockNumber = await fetchEvmBlockNumber(CHAIN, {
      signal: input.signal,
      timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
      chainRpcs: input.chainRpcs,
      maxRetries: 0,
    });
    if (blockNumber == null) throw new Error("uniswap-v3-bsc-block-unavailable");

    const stateCalls = candidates.flatMap((candidate, index) => {
      const prefix = `univ3-bsc-${index}`;
      const poolCall = (functionName: "factory" | "token0" | "token1" | "fee" | "slot0") => ({
        label: `${prefix}-${functionName}`,
        target: candidate.poolAddress,
        callData: encodeFunctionData({ abi: POOL_ABI, functionName }),
      });
      return [
        poolCall("factory"),
        poolCall("token0"),
        poolCall("token1"),
        poolCall("fee"),
        poolCall("slot0"),
        ...erc20RecoveryCalls(prefix, candidate.poolAddress, candidate.expectedTokens),
      ];
    });
    const rawState = await fetchEvmMulticall3Aggregate3AtBlock(CHAIN, stateCalls, blockNumber, {
      signal: input.signal,
      timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
      chainRpcs: input.chainRpcs,
      maxRetries: 0,
      multicallBatchSize: MULTICALL_BATCH_SIZE,
    });
    if (!rawState) throw new Error("uniswap-v3-bsc-state-unavailable");
    const state = mapStagedMulticallResults(rawState);

    const decoded = candidates.flatMap((candidate, index) => {
      const prefix = `univ3-bsc-${index}`;
      const factory = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-factory`), POOL_ABI, "factory"));
      const token0 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token0`), POOL_ABI, "token0"));
      const token1 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token1`), POOL_ABI, "token1"));
      const fee = Number(decodeStagedMulticallResult<number>(state.get(`${prefix}-fee`), POOL_ABI, "fee"));
      const slot0 = decodeStagedMulticallResult<readonly [bigint, number, number, number, number, number, boolean]>(
        state.get(`${prefix}-slot0`),
        POOL_ABI,
        "slot0",
      );
      if (
        factory !== deployment.factoryAddress ||
        !token0 ||
        !token1 ||
        token0 === token1 ||
        !candidate.expectedTokens.has(token0) ||
        !candidate.expectedTokens.has(token1) ||
        !Number.isInteger(fee) ||
        fee <= 0 ||
        fee > 1_000_000 ||
        !slot0 ||
        slot0[0] <= 0n
      ) return [];
      return [{ candidate, prefix, token0, token1, fee, sqrtPriceX96: slot0[0] }];
    });
    if (decoded.length === 0) return successfulResult([]);

    const bindingCalls = decoded.map((row, index) => ({
      label: `univ3-bsc-binding-${index}`,
      target: deployment.factoryAddress,
      callData: encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [row.token0, row.token1, row.fee],
      }),
    }));
    const rawBindings = await fetchEvmMulticall3Aggregate3AtBlock(CHAIN, bindingCalls, blockNumber, {
      signal: input.signal,
      timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
      chainRpcs: input.chainRpcs,
      maxRetries: 0,
      multicallBatchSize: MULTICALL_BATCH_SIZE,
    });
    if (!rawBindings) throw new Error("uniswap-v3-bsc-binding-unavailable");
    const bindings = mapStagedMulticallResults(rawBindings);

    const pools: DexApiPool[] = [];
    for (let index = 0; index < decoded.length; index++) {
      const row = decoded[index]!;
      const resolvedPool = canonicalEvmAddress(
        decodeStagedMulticallResult<string>(bindings.get(`univ3-bsc-binding-${index}`), FACTORY_ABI, "getPool"),
      );
      if (resolvedPool !== row.candidate.poolAddress) continue;
      const stagedTokens = [...row.candidate.expectedTokens];
      const tokenRows = [row.token0, row.token1].flatMap((address, tokenIndex) => {
        const stagedIndex = stagedTokens.indexOf(address);
        const decimals = Number(decodeStagedMulticallResult<number>(
          state.get(`${row.prefix}-token-${stagedIndex}-decimals`),
          ERC20_RECOVERY_ABI,
          "decimals",
        ));
        const rawBalance = decodeStagedMulticallResult<bigint>(
          state.get(`${row.prefix}-token-${stagedIndex}-balance`),
          ERC20_RECOVERY_ABI,
          "balanceOf",
        );
        if (
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 255 ||
          rawBalance == null ||
          rawBalance <= 0n
        ) return [];
        const trackedAssetId = input.chainAddressToId.get(buildChainAddressKey(CHAIN, address));
        const directPrice = trackedAssetId ? input.trackedStablecoinPrices.get(trackedAssetId) : null;
        return [{
          address,
          symbol: trackedAssetId ?? `TOKEN${tokenIndex}`,
          decimals,
          balance: rawAmountToDecimal(rawBalance, decimals),
          trackedAssetId,
          directPrice,
        }];
      });
      if (tokenRows.length !== 2) continue;
      const spot = sqrtRatioToSpotPrice(
        row.sqrtPriceX96,
        tokenRows[0]!.decimals,
        tokenRows[1]!.decimals,
      );
      if (!Number.isFinite(spot) || spot <= 0) continue;
      const token0Price = tokenRows[0]!.directPrice ??
        (tokenRows[1]!.directPrice != null ? spot * tokenRows[1]!.directPrice : null);
      const token1Price = tokenRows[1]!.directPrice ??
        (tokenRows[0]!.directPrice != null ? tokenRows[0]!.directPrice / spot : null);
      if (
        token0Price == null ||
        token1Price == null ||
        !Number.isFinite(token0Price) ||
        !Number.isFinite(token1Price) ||
        token0Price <= 0 ||
        token1Price <= 0 ||
        (!tokenRows[0]!.trackedAssetId && !tokenRows[1]!.trackedAssetId)
      ) continue;
      const tvlUsd = tokenRows[0]!.balance * token0Price + tokenRows[1]!.balance * token1Price;
      if (
        !Number.isFinite(tvlUsd) ||
        tvlUsd < DIRECT_API_POOL_MIN_TVL_USD ||
        tvlUsd > DIRECT_API_MAX_POOL_TVL_USD
      ) continue;
      pools.push({
        source: "uniswap-v3-shadow",
        chain: CHAIN,
        poolAddress: row.candidate.poolAddress,
        poolType: "uniswap-v3-shadow",
        tokens: tokenRows.map((token, tokenIndex) => ({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          priceUsd: tokenIndex === 0 ? token0Price : token1Price,
        })),
        price: spot,
        tvlUsd,
        volume24hUsd: 0,
        feeRate: row.fee / 1_000_000,
        balances: tokenRows.map((token) => token.balance),
        balancesNormalized: true,
      });
    }
    return successfulResult(pools);
  } catch (error) {
    return makeDexApiFetchResult([], {
      ok: false,
      degraded: true,
      errors: [toErrorMessage(error)],
    });
  }
}
