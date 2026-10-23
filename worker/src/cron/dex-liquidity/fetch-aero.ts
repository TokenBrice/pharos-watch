import { logWorkerEventArgs } from "../../lib/structured-log";
import { encodeFunctionData, parseAbi } from "viem/utils";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { throwIfAborted } from "../../lib/abort";
import {
  fetchEvmBlockNumber,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { buildChainAddressKey } from "./token-resolution";
import { classifyClPoolType, normalizeFeeRateFromBps } from "./direct-source-helpers";
import { DIRECT_API_PROVIDER_TIMEOUT_MS, DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import {
  captureClSourcePools,
  decodeStagedMulticallResult,
  mapStagedMulticallResults,
  rawAmountToDecimal,
} from "./staged-pool-recovery";
import { toErrorMessage } from "@shared/lib/error-utils";
import { canonicalEvmAddress } from "@shared/lib/evm-address";

import { AERO_DEPLOYMENTS } from "./aero-deployments";

export { AERO_CHAINS, AERO_DEPLOYMENTS } from "./aero-deployments";

/**
 * Per-run read bound. A larger factory reads its oldest pools (where the
 * long-lived liquidity sits) and reports the chain degraded with a named
 * `pool-count-cap` reason instead of truncating silently (#1630).
 */
const MAX_POOLS_PER_FACTORY = 5_000;
const MULTICALL_BATCH_SIZE = 150;
/**
 * Serial chain reads stop with headroom before the outer provider timeout, so
 * a slow late chain degrades by name instead of discarding earlier chains.
 */
const AERO_RUN_BUDGET_MS = DIRECT_API_PROVIDER_TIMEOUT_MS - 15_000;

const FACTORY_ABI = parseAbi([
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256 index) view returns (address)",
  "function tickSpacingToFee(int24 tickSpacing) view returns (uint24)",
  "function getPool(address tokenA, address tokenB) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, address t0, address t1)",
]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

interface AeroFetchInput {
  chainAddressToId: Map<string, string>;
  trackedStablecoinPrices: Map<string, number>;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

function rpcOptions(input: AeroFetchInput): EvmRpcOptions {
  return {
    signal: input.signal,
    timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
    chainRpcs: input.chainRpcs,
    multicallBatchSize: MULTICALL_BATCH_SIZE,
  };
}

async function multicallAtBlock(
  chain: string,
  calls: readonly EvmMulticall3Call[],
  block: number,
  options: EvmRpcOptions,
  stage: string,
) {
  const results = await fetchEvmMulticall3Aggregate3AtBlock(chain, calls, block, options);
  if (!results) throw new Error(`${stage}-unavailable`);
  return mapStagedMulticallResults(results);
}

function isTracked(input: AeroFetchInput, chain: string, address: string | null): boolean {
  return address != null && input.chainAddressToId.has(buildChainAddressKey(chain, address));
}

function trackedPrice(input: AeroFetchInput, chain: string, address: string): number | null {
  const id = input.chainAddressToId.get(buildChainAddressKey(chain, address));
  const price = id ? input.trackedStablecoinPrices.get(id) : undefined;
  return price != null && Number.isFinite(price) && price > 0 ? price : null;
}

async function readFactoryPools(
  chain: string,
  factories: readonly `0x${string}`[],
  block: number,
  options: EvmRpcOptions,
  warnings: string[],
): Promise<{ factory: `0x${string}`; pool: `0x${string}` }[]> {
  const counts = await multicallAtBlock(chain, factories.map((factory, index) => ({
    label: `count-${index}`,
    target: factory,
    callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: "allPoolsLength" }),
  })), block, options, "pool-count");
  const calls: EvmMulticall3Call[] = [];
  factories.forEach((factory, index) => {
    const count = decodeStagedMulticallResult<bigint>(counts.get(`count-${index}`), FACTORY_ABI, "allPoolsLength");
    if (count == null) throw new Error(`pool-count-unavailable:${factory}`);
    if (count > BigInt(MAX_POOLS_PER_FACTORY)) warnings.push(`pool-count-cap:${factory}:${count}`);
    const readCount = count > BigInt(MAX_POOLS_PER_FACTORY) ? MAX_POOLS_PER_FACTORY : Number(count);
    for (let i = 0; i < readCount; i++) {
      calls.push({
        label: `${factory}-${i}`,
        target: factory,
        callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: "allPools", args: [BigInt(i)] }),
      });
    }
  });
  const pools = await multicallAtBlock(chain, calls, block, options, "pool-list");
  return calls.map((call) => {
    const pool = canonicalEvmAddress(decodeStagedMulticallResult<string>(pools.get(call.label), FACTORY_ABI, "allPools"));
    if (!pool) throw new Error(`pool-list-incomplete:${call.label}`);
    return { factory: call.target as `0x${string}`, pool: pool as `0x${string}` };
  });
}

async function readSymbols(
  chain: string,
  addresses: readonly string[],
  block: number,
  options: EvmRpcOptions,
): Promise<Map<string, string>> {
  const unique = [...new Set(addresses)];
  const results = await multicallAtBlock(chain, unique.map((address) => ({
    label: `${address}-symbol`,
    target: address,
    callData: encodeFunctionData({ abi: SYMBOL_ABI, functionName: "symbol" }),
  })), block, options, "token-symbols");
  const symbols = new Map<string, string>();
  for (const address of unique) {
    const symbol = decodeStagedMulticallResult<string>(results.get(`${address}-symbol`), SYMBOL_ABI, "symbol")?.trim();
    // bytes32-symbol tokens fail the string decode; the address stays the label.
    symbols.set(address, symbol || address);
  }
  return symbols;
}

/** Tick spacing's base fee in basis points; the swap hook's live per-swap fee is not a tier. */
export function aeroBaseFeeBps(feePips: number | null): number | null {
  if (feePips == null || !Number.isInteger(feePips) || feePips <= 0 || feePips > 1_000_000) return null;
  return feePips / 100;
}

async function fetchAeroSlipstreamChain(
  input: AeroFetchInput,
  deployment: (typeof AERO_DEPLOYMENTS)[number],
  warnings: string[],
): Promise<DexApiPool[]> {
  const { chain } = deployment;
  const options = rpcOptions(input);
  const block = await fetchEvmBlockNumber(chain, options);
  if (block == null) throw new Error("block-unavailable");
  const listed = await readFactoryPools(chain, deployment.clFactories, block, options, warnings);
  if (listed.length === 0) return [];

  const tokenState = await multicallAtBlock(chain, listed.flatMap(({ pool }) => (["token0", "token1"] as const).map((fn) => ({
    label: `${pool}-${fn}`,
    target: pool,
    callData: encodeFunctionData({ abi: POOL_ABI, functionName: fn }),
  }))), block, options, "pool-tokens");
  const tokens = new Map(listed.map(({ pool }) => [pool, (["token0", "token1"] as const).map((fn) =>
    canonicalEvmAddress(decodeStagedMulticallResult<string>(tokenState.get(`${pool}-${fn}`), POOL_ABI, fn)))]));
  // An unreadable pool is missing evidence, not a proven non-stablecoin pool.
  const unreadable = [...tokens.values()].filter((pair) => pair.some((token) => token == null)).length;
  if (unreadable > 0) warnings.push(`pool-tokens-unreadable:${unreadable}`);
  const pools: DexApiPool[] = [];
  for (const factory of deployment.clFactories) {
    throwIfAborted(input.signal);
    const candidates = listed.filter((row) => row.factory === factory &&
      tokens.get(row.pool)!.some((token) => isTracked(input, chain, token)),
    ).map((row) => ({ poolAddress: row.pool }));
    if (candidates.length === 0) continue;

    // Factory binding, exact getPool membership, balances and sqrt price are
    // read at one pinned block hash; pools failing any proof are dropped.
    const capture = await captureClSourcePools({
      chain,
      factoryAddress: factory,
      parameterName: "tickSpacing",
      maxParameter: 32_767,
      valuation: "pool-implied",
      candidates,
      chainAddressToId: input.chainAddressToId,
      trackedStablecoinPrices: input.trackedStablecoinPrices,
      options,
    });
    if (capture.pools.length === 0) continue;
    const tickSpacings = [...new Set(capture.pools.map((pool) => pool.parameter))];
    const fees = await multicallAtBlock(chain, tickSpacings.map((tickSpacing) => ({
      label: `fee-${tickSpacing}`,
      target: factory,
      callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: "tickSpacingToFee", args: [tickSpacing] }),
    })), capture.blockNumber, options, "tick-spacing-fees");
    const symbols = await readSymbols(chain, capture.pools.flatMap((pool) => pool.tokens.map((token) => token.address)), capture.blockNumber, options);
    for (const pool of capture.pools) {
      const feeBps = aeroBaseFeeBps(decodeStagedMulticallResult<number>(fees.get(`fee-${pool.parameter}`), FACTORY_ABI, "tickSpacingToFee"));
      pools.push({
        source: "aero-slipstream",
        chain,
        poolAddress: pool.candidate.poolAddress,
        poolType: classifyClPoolType("aero-slipstream", feeBps),
        tokens: pool.tokens.map((token) => ({
          ...token,
          symbol: symbols.get(token.address) ?? token.symbol,
          // A tracked side's USD value is a reference, not an observation of
          // this pool; leave it unset so price evidence comes from the pool.
          priceUsd: isTracked(input, chain, token.address) ? undefined : token.priceUsd,
        })),
        price: pool.price,
        tvlUsd: pool.tvlUsd,
        // Pool state carries no trailing volume: no observation, not zero.
        volume24hUsd: null,
        feeRate: normalizeFeeRateFromBps(feeBps),
        tickSpacing: pool.parameter,
        balances: pool.balances,
      });
    }
  }
  return pools;
}

async function fetchAeroBasicChain(
  input: AeroFetchInput,
  deployment: (typeof AERO_DEPLOYMENTS)[number],
  warnings: string[],
): Promise<DexApiPool[]> {
  const { chain } = deployment;
  const options = rpcOptions(input);
  const block = await fetchEvmBlockNumber(chain, options);
  if (block == null) throw new Error("block-unavailable");
  const stableFactories = new Set<string>(deployment.stableFactories);
  const listed = await readFactoryPools(chain, [...deployment.stableFactories, ...deployment.volatileFactories], block, options, warnings);
  if (listed.length === 0) return [];

  const state = await multicallAtBlock(chain, listed.flatMap(({ pool }) => (["factory", "metadata"] as const).map((fn) => ({
    label: `${pool}-${fn}`,
    target: pool,
    callData: encodeFunctionData({ abi: POOL_ABI, functionName: fn }),
  }))), block, options, "pool-state");
  let unreadable = 0;
  const decoded = listed.flatMap((row) => {
    const factory = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${row.pool}-factory`), POOL_ABI, "factory"));
    const meta = decodeStagedMulticallResult<readonly [bigint, bigint, bigint, bigint, string, string]>(
      state.get(`${row.pool}-metadata`), POOL_ABI, "metadata",
    );
    if (!meta || factory == null) {
      unreadable++;
      return [];
    }
    const token0 = canonicalEvmAddress(meta[4]);
    const token1 = canonicalEvmAddress(meta[5]);
    if (factory !== row.factory || !token0 || !token1 || token0 === token1) return [];
    if (!isTracked(input, chain, token0) && !isTracked(input, chain, token1)) return [];
    // metadata() returns decimals as 10**decimals multipliers.
    const decimals = [meta[0], meta[1]].map((multiplier) => {
      const digits = multiplier.toString().length - 1;
      return multiplier === 10n ** BigInt(digits) ? digits : null;
    });
    if (decimals[0] == null || decimals[1] == null) return [];
    return [{
      ...row, token0, token1, decimals0: decimals[0], decimals1: decimals[1],
      reserve0: rawAmountToDecimal(meta[2], decimals[0]), reserve1: rawAmountToDecimal(meta[3], decimals[1]),
    }];
  });
  // An unreadable pool is missing evidence, not a proven non-stablecoin pool.
  if (unreadable > 0) warnings.push(`pool-state-unreadable:${unreadable}`);
  if (decoded.length === 0) return [];

  const membership = await multicallAtBlock(chain, decoded.map((row) => ({
    label: row.pool,
    target: row.factory,
    callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [row.token0 as `0x${string}`, row.token1 as `0x${string}`] }),
  })), block, options, "pool-membership");
  const symbols = await readSymbols(chain, decoded.flatMap((row) => [row.token0, row.token1]), block, options);

  const pools: DexApiPool[] = [];
  let membershipUnreadable = 0;
  for (const row of decoded) {
    const member = canonicalEvmAddress(decodeStagedMulticallResult<string>(membership.get(row.pool), FACTORY_ABI, "getPool"));
    if (member == null) {
      membershipUnreadable++;
      continue;
    }
    if (member !== row.pool) continue;
    // Explicit zero reserves are observations; only the ratio needs both sides.
    if (!(row.reserve0 >= 0) || !(row.reserve1 >= 0)) continue;
    const stable = stableFactories.has(row.factory);
    let price0 = trackedPrice(input, chain, row.token0);
    let price1 = trackedPrice(input, chain, row.token1);
    // x*y=k marginal price is the reserve ratio; stable-curve pools have no
    // such closed form, so they need both sides independently priced.
    const spot = !stable && row.reserve0 > 0 && row.reserve1 > 0 ? row.reserve1 / row.reserve0 : null;
    if (price0 == null && price1 != null && spot != null) price0 = spot * price1;
    if (price1 == null && price0 != null && spot != null) price1 = price0 / spot;
    if (price0 == null || price1 == null) continue;
    const tvlUsd = row.reserve0 * price0 + row.reserve1 * price1;
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;
    pools.push({
      source: "aero-basic",
      chain,
      poolAddress: row.pool,
      poolType: stable ? "aero-stable" : "aero-volatile",
      // Only an untracked side carries its pool-implied USD value; tracked
      // sides stay references so they never re-emit as pool price evidence.
      tokens: [
        { address: row.token0, symbol: symbols.get(row.token0) ?? row.token0, decimals: row.decimals0, priceUsd: isTracked(input, chain, row.token0) ? undefined : price0 },
        { address: row.token1, symbol: symbols.get(row.token1) ?? row.token1, decimals: row.decimals1, priceUsd: isTracked(input, chain, row.token1) ? undefined : price1 },
      ],
      price: spot,
      tvlUsd,
      volume24hUsd: null,
      // Fees are set per pool by fee modules; no tier claim is made.
      feeRate: null,
      balances: [row.reserve0, row.reserve1],
    });
  }
  if (membershipUnreadable > 0) warnings.push(`pool-membership-unreadable:${membershipUnreadable}`);
  return pools;
}

async function fetchAeroPools(
  source: "aero-slipstream" | "aero-basic",
  input: AeroFetchInput,
): Promise<DexApiFetchResult> {
  const pools: DexApiPool[] = [];
  const errors: string[] = [];
  // Chains are read serially so the adapter never holds more than one RPC
  // connection open at a time.
  const deadline = Date.now() + AERO_RUN_BUDGET_MS;
  for (const deployment of AERO_DEPLOYMENTS) {
    throwIfAborted(input.signal);
    const warnings: string[] = [];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      warnings.push("run-budget-exhausted");
    } else {
      const budget = AbortSignal.timeout(remainingMs);
      const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
      try {
        pools.push(...await (source === "aero-slipstream" ? fetchAeroSlipstreamChain : fetchAeroBasicChain)(
          { ...input, signal }, deployment, warnings,
        ));
      } catch (error) {
        if (input.signal?.aborted) throw error;
        warnings.push(budget.aborted ? "run-budget-exhausted" : toErrorMessage(error));
      }
    }
    for (const warning of warnings) {
      const message = `${deployment.chain}:${warning}`;
      errors.push(message);
      logWorkerEventArgs("handler", "warn", `[fetch-aero] ${source}`, message);
    }
  }
  if (pools.length > 0) logWorkerEventArgs("handler", "info", `[fetch-aero] ${source} fetched ${pools.length} pools`);
  return makeDexApiFetchResult(pools, {
    ok: pools.length > 0 || errors.length === 0,
    degraded: errors.length > 0,
    errors,
  });
}

export function fetchAeroSlipstreamPools(input: AeroFetchInput): Promise<DexApiFetchResult> {
  return fetchAeroPools("aero-slipstream", input);
}

export function fetchAeroBasicPools(input: AeroFetchInput): Promise<DexApiFetchResult> {
  return fetchAeroPools("aero-basic", input);
}
