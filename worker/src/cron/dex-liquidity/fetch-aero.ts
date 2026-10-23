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
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import {
  captureClSourcePools,
  decodeStagedMulticallResult,
  mapStagedMulticallResults,
  rawAmountToDecimal,
} from "./staged-pool-recovery";
import { toErrorMessage } from "@shared/lib/error-utils";
import { canonicalEvmAddress } from "@shared/lib/evm-address";

/**
 * Aero (aero.xyz) — the 2026-10-22 merger of Aerodrome and Velodrome — on its
 * seven launch chains. Aero publishes no Sugar or HTTP pool API, so pools are
 * enumerated straight from the factories. Reviewed against Dromos Labs'
 * deployment registries (`dromos-labs/metadex-public` and
 * `metadex-slipstream-public`, `deployment-addresses/`) and live
 * `allPoolsLength()` reads on 2026-10-23. Arc also carries the pre-merger
 * "Aero Lite" factories, which the DefiLlama Aero listing includes. Ink is
 * omitted: the reviewed Worker RPC profile has no Ink endpoint (and Aero held
 * ~$0 there at launch); GeckoTerminal `aero-slipstream-ink` rows still stage.
 */
export const AERO_DEPLOYMENTS: readonly {
  chain: string;
  clFactories: readonly `0x${string}`[];
  stableFactories: readonly `0x${string}`[];
  volatileFactories: readonly `0x${string}`[];
}[] = [
  ...([
    ["base", "0x9cb220581b91b0c83223012fe69688b92ad07a76"],
    ["ethereum", "0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2"],
    ["optimism", "0xfeab42d90055db3a0616249f76b6002d72266778"],
    ["arbitrum", "0x88a60ee77392577c355c0acb2a8d476d5a4ec03a"],
    ["robinhood", "0xc63d7338c178e805c544b8f897066bd3bbcbe136"],
  ] as const).map(([chain, clFactory]) => ({
    chain,
    clFactories: [clFactory],
    stableFactories: ["0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d" as const],
    volatileFactories: ["0x8e6a9fcd1d638cc760ffba397605fe3355de76d2" as const],
  })),
  {
    chain: "arc",
    clFactories: ["0x7f83235643181e440433400a027618cd50879751", "0xb89df768af2cfe637ceb352c587fe8edaf491d03"],
    stableFactories: ["0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d", "0xaed253f1ad84d99f2165256d701b2b481dd4cc16"],
    volatileFactories: ["0x8e6a9fcd1d638cc760ffba397605fe3355de76d2", "0x9bc8b3f60d349d687fb44a018967025e3741f9a5"],
  },
];

export const AERO_CHAINS: readonly string[] = AERO_DEPLOYMENTS.map((deployment) => deployment.chain);

/** Fail closed instead of silently truncating a factory that outgrew the reviewed read shape. */
const MAX_POOLS_PER_FACTORY = 5_000;
const MULTICALL_BATCH_SIZE = 150;

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
    if (count > BigInt(MAX_POOLS_PER_FACTORY)) throw new Error(`pool-count-cap:${factory}:${count}`);
    for (let i = 0; i < Number(count); i++) {
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
): Promise<DexApiPool[]> {
  const { chain } = deployment;
  const options = rpcOptions(input);
  const block = await fetchEvmBlockNumber(chain, options);
  if (block == null) throw new Error("block-unavailable");
  const listed = await readFactoryPools(chain, deployment.clFactories, block, options);
  if (listed.length === 0) return [];

  const tokenState = await multicallAtBlock(chain, listed.flatMap(({ pool }) => (["token0", "token1"] as const).map((fn) => ({
    label: `${pool}-${fn}`,
    target: pool,
    callData: encodeFunctionData({ abi: POOL_ABI, functionName: fn }),
  }))), block, options, "pool-tokens");
  const pools: DexApiPool[] = [];
  for (const factory of deployment.clFactories) {
    throwIfAborted(input.signal);
    const candidates = listed.filter((row) => row.factory === factory && (
      isTracked(input, chain, canonicalEvmAddress(decodeStagedMulticallResult<string>(tokenState.get(`${row.pool}-token0`), POOL_ABI, "token0"))) ||
      isTracked(input, chain, canonicalEvmAddress(decodeStagedMulticallResult<string>(tokenState.get(`${row.pool}-token1`), POOL_ABI, "token1")))
    )).map((row) => ({ poolAddress: row.pool }));
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
): Promise<DexApiPool[]> {
  const { chain } = deployment;
  const options = rpcOptions(input);
  const block = await fetchEvmBlockNumber(chain, options);
  if (block == null) throw new Error("block-unavailable");
  const stableFactories = new Set<string>(deployment.stableFactories);
  const listed = await readFactoryPools(chain, [...deployment.stableFactories, ...deployment.volatileFactories], block, options);
  if (listed.length === 0) return [];

  const state = await multicallAtBlock(chain, listed.flatMap(({ pool }) => (["factory", "metadata"] as const).map((fn) => ({
    label: `${pool}-${fn}`,
    target: pool,
    callData: encodeFunctionData({ abi: POOL_ABI, functionName: fn }),
  }))), block, options, "pool-state");
  const decoded = listed.flatMap((row) => {
    const factory = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${row.pool}-factory`), POOL_ABI, "factory"));
    const meta = decodeStagedMulticallResult<readonly [bigint, bigint, bigint, bigint, string, string]>(
      state.get(`${row.pool}-metadata`), POOL_ABI, "metadata",
    );
    const token0 = canonicalEvmAddress(meta?.[4]);
    const token1 = canonicalEvmAddress(meta?.[5]);
    if (!meta || factory !== row.factory || !token0 || !token1 || token0 === token1) return [];
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
  if (decoded.length === 0) return [];

  const membership = await multicallAtBlock(chain, decoded.map((row) => ({
    label: row.pool,
    target: row.factory,
    callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [row.token0 as `0x${string}`, row.token1 as `0x${string}`] }),
  })), block, options, "pool-membership");
  const symbols = await readSymbols(chain, decoded.flatMap((row) => [row.token0, row.token1]), block, options);

  const pools: DexApiPool[] = [];
  for (const row of decoded) {
    if (canonicalEvmAddress(decodeStagedMulticallResult<string>(membership.get(row.pool), FACTORY_ABI, "getPool")) !== row.pool) continue;
    if (!(row.reserve0 > 0) || !(row.reserve1 > 0)) continue;
    const stable = stableFactories.has(row.factory);
    let price0 = trackedPrice(input, chain, row.token0);
    let price1 = trackedPrice(input, chain, row.token1);
    // x*y=k marginal price is the reserve ratio; stable-curve pools have no
    // such closed form, so they need both sides independently priced.
    const spot = stable ? null : row.reserve1 / row.reserve0;
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
  for (const deployment of AERO_DEPLOYMENTS) {
    throwIfAborted(input.signal);
    try {
      pools.push(...await (source === "aero-slipstream" ? fetchAeroSlipstreamChain : fetchAeroBasicChain)(input, deployment));
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = `${deployment.chain}:${toErrorMessage(error)}`;
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
