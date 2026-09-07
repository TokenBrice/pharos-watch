import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmBlockHeader,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { normalizeProtocol } from "./pool-helpers";
import { hasScoreFacingMeasuredExecution, resolveUniqueTrackedTokenIndex } from "./scoring-helpers";
import type { LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";

/**
 * Curve StableSwap-NG deployments whose pool inventory is only readable from
 * the chain, because Curve's own `getPools` endpoint does not serve the
 * network at all (`/v1/getPlatforms` omits it, and `/v1/getPools/all/<chain>`
 * answers `ParamError: Invalid value for param "blockchainId"`). Without a
 * pool census the source-only Curve join has no pool address to resolve, so
 * every retained Curve row on such a chain gates at
 * `curve-stableswap:exact-pool-join-unresolved` and contributes no exit route.
 *
 * This is not a generic Curve-fork allowlist and it is not a chain toggle. A
 * deployment is admitted only when, at one fresh confirmed block, the pinned
 * factory's runtime code hash matches, the pinned pool-implementation
 * blueprint's runtime code hash matches, and the factory itself both indexes
 * the candidate pool in `pool_list` and attests its coins, decimals, balances,
 * amplification, and non-meta shape. Any mismatch keeps the original gate.
 *
 * Verified 2026-09-01 against `https://rpc.plasma.to` at Plasma head block
 * 31,321,392: `pool_count()` = 21, exactly one indexed pool (index 13,
 * `0x085bad2c28bdd4a40396072d3eb2636bf7afa39c`) holds a tracked stablecoin
 * this registry can price, `is_meta` = false, `get_A` = 1000, `get_fees` =
 * (1_000_000, 5_000_000_000), `stored_rates` = the base rates 1e18 / 1e30.
 */
export interface CurveStableswapFactoryDeployment {
  /** Pharos chain id. */
  chain: string;
  /** Curve registry family this factory deploys; only plain StableSwap-NG is modeled. */
  registryId: "factory-stable-ng";
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
  /** Blueprint the factory must report for every admitted pool. */
  expectedPoolImplementationAddress: `0x${string}`;
  expectedPoolImplementationCodeHash: `0x${string}`;
  /**
   * Upper bound on the indexed pools this stage will enumerate in one run. A
   * factory that has grown past the bound fails closed rather than resolving a
   * join from a truncated inventory.
   */
  maxIndexedPools: number;
}

export const CURVE_STABLESWAP_FACTORY_DEPLOYMENTS: readonly CurveStableswapFactoryDeployment[] = [
  {
    chain: "plasma",
    registryId: "factory-stable-ng",
    factoryAddress: "0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad",
    expectedFactoryCodeHash: "0xded1a5a542411bf8bced670953ccbed8dfc0443ee9d0e190e61cebc31631f87f",
    expectedPoolImplementationAddress: "0xfc687efafed297b765edecf8179c32195597c2df",
    expectedPoolImplementationCodeHash: "0x620bf33fca9d3555fa15de7b13cdbc279dcaf2c55844df479781f86425895a17",
    maxIndexedPools: 64,
  },
] as const;

/** A source-stage capture must reflect the current head, not a reusable quote profile. */
const CURVE_STABLESWAP_FACTORY_CAPTURE_MAX_AGE_SEC = 10 * 60;

const CURVE_STABLESWAP_FEE_DENOMINATOR = 10n ** 10n;
const MAX_POOL_COINS = 8;
const MAX_CALLS_PER_MULTICALL_ROUND = 96;

const CURVE_FACTORY_ABI = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address) view returns (address[])",
  "function get_decimals(address) view returns (uint256[])",
  "function get_balances(address) view returns (uint256[])",
  "function get_A(address) view returns (uint256)",
  "function is_meta(address) view returns (bool)",
  "function get_implementation_address(address) view returns (address)",
]);
const CURVE_POOL_ABI = parseAbi([
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const ERC20_SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

export interface CurveStableswapFactoryDependencies {
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  fetchCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
  hashCode: (code: `0x${string}`) => `0x${string}`;
}

const DEFAULT_DEPENDENCIES: CurveStableswapFactoryDependencies = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockHeader: fetchEvmBlockHeader,
  fetchCodeAtBlock: fetchEvmCodeAtBlock,
  fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock,
  hashCode: keccak256,
};

interface FactoryReference {
  stablecoinId: string;
  pool: PoolEntry;
}

interface IndexedPool {
  index: number;
  address: `0x${string}`;
  coins: `0x${string}`[];
}

interface FactoryPoolState {
  address: `0x${string}`;
  coins: `0x${string}`[];
  decimals: number[];
  balances: bigint[];
  amplification: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  storedRates: bigint[];
  symbols: string[];
}

type CurveGateReason = DexExecutionCapabilityGate["reason"];

function asEvmAddress(chain: string, value: string | null | undefined): `0x${string}` | null {
  const normalized = canonicalExitRouteScopedId(chain, value ?? "");
  return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

/**
 * The stage owns exactly one gate: a Curve StableSwap row whose physical pool
 * the source-only join could not resolve. Every other Curve gate (metapool,
 * rate-bearing, CryptoSwap, invalid parameters) stays with the reviewed path
 * that produced it.
 */
function isUnresolvedCurveStableswapJoin(pool: PoolEntry): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "curve-stableswap" && gate.reason === "exact-pool-join-unresolved";
}

function gateReference(reference: FactoryReference, reason: CurveGateReason): void {
  const extra = { ...(reference.pool.extra ?? {}) };
  extra.executionCapabilityGate = { family: "curve-stableswap", reason };
  reference.pool.extra = extra;
}

function resultMap(results: readonly EvmMulticall3Result[]): Map<string, EvmMulticall3Result> {
  return new Map(results.map((result) => [result.label, result]));
}

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "uint256" }], result.returnData);
    return value;
  } catch {
    return null;
  }
}

function decodeUint256Array(result: EvmMulticall3Result | undefined): bigint[] | null {
  if (!result?.success) return null;
  try {
    const [values] = decodeAbiParameters([{ type: "uint256[]" }], result.returnData);
    return Array.isArray(values) ? [...values] : null;
  } catch {
    return null;
  }
}

function decodeAddress(chain: string, result: EvmMulticall3Result | undefined): `0x${string}` | null {
  if (!result?.success) return null;
  try {
    const [address] = decodeAbiParameters([{ type: "address" }], result.returnData);
    return asEvmAddress(chain, address);
  } catch {
    return null;
  }
}

function decodeAddressArray(chain: string, result: EvmMulticall3Result | undefined): `0x${string}`[] | null {
  if (!result?.success) return null;
  try {
    const [values] = decodeAbiParameters([{ type: "address[]" }], result.returnData);
    if (!Array.isArray(values)) return null;
    const addresses = values.map((value) => asEvmAddress(chain, value as string));
    return addresses.some((address) => address == null) ? null : (addresses as `0x${string}`[]);
  } catch {
    return null;
  }
}

function decodeBool(result: EvmMulticall3Result | undefined): boolean | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "bool" }], result.returnData);
    return value;
  } catch {
    return null;
  }
}

function decodeString(result: EvmMulticall3Result | undefined): string | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], result.returnData);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

async function runMulticallRounds(input: {
  chain: string;
  calls: { label: string; target: `0x${string}`; callData: `0x${string}` }[];
  blockNumber: number;
  rpcOptions: Parameters<typeof fetchEvmMulticall3Aggregate3AtBlock>[3];
  signal?: AbortSignal;
  dependencies: CurveStableswapFactoryDependencies;
}): Promise<Map<string, EvmMulticall3Result> | null> {
  const collected: EvmMulticall3Result[] = [];
  for (let start = 0; start < input.calls.length; start += MAX_CALLS_PER_MULTICALL_ROUND) {
    throwIfAborted(input.signal);
    const results = await input.dependencies.fetchMulticall(
      input.chain,
      input.calls.slice(start, start + MAX_CALLS_PER_MULTICALL_ROUND),
      input.blockNumber,
      input.rpcOptions,
    );
    if (!results) return null;
    collected.push(...results);
  }
  return resultMap(collected);
}

function isFreshHeader(header: EvmBlockHeader, nowSec: number): boolean {
  return (
    Number.isSafeInteger(nowSec) &&
    header.timestamp <= nowSec + 60 &&
    nowSec - header.timestamp <= CURVE_STABLESWAP_FACTORY_CAPTURE_MAX_AGE_SEC
  );
}

function toTokenUnits(value: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value <= 0n) return null;
  const amount = Number(value) / 10 ** decimals;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Build the plain-StableSwap execution model from factory-attested state.
 *
 * Only base stored rates are admitted: a rate-bearing NG pool is a different
 * reviewed model and belongs to `curve-stableswap-rates.ts`, which keeps its
 * own `rate-bearing-inputs` gate.
 */
function buildCurveStableswapFactoryExecutionModel(input: {
  chain: string;
  stablecoinId: string;
  state: FactoryPoolState;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
}): { model: DexAmmExecutionModel | null; reason: CurveGateReason } {
  const { state } = input;
  const tokenCount = state.coins.length;
  if (
    tokenCount < 2 ||
    tokenCount > MAX_POOL_COINS ||
    state.decimals.length !== tokenCount ||
    state.balances.length !== tokenCount ||
    state.storedRates.length !== tokenCount ||
    state.symbols.length !== tokenCount
  ) {
    return { model: null, reason: "incomplete-exact-capture" };
  }
  if (new Set(state.coins).size !== tokenCount) {
    return { model: null, reason: "ambiguous-token-identity" };
  }
  for (let index = 0; index < tokenCount; index++) {
    const decimals = state.decimals[index]!;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return { model: null, reason: "incomplete-exact-capture" };
    }
    if (state.storedRates[index] !== 10n ** BigInt(36 - decimals)) {
      return { model: null, reason: "rate-bearing-inputs" };
    }
  }
  if (state.amplification <= 0n) {
    return { model: null, reason: "invalid-invariant-parameters" };
  }
  // Curve NG `A()` exposes the contract convention (Ann = A_contract * n).
  // The shared simulator uses the plain paper convention (Ann = A * n^n).
  const amplification = Number(state.amplification) / tokenCount ** (tokenCount - 1);
  if (!Number.isFinite(amplification) || amplification <= 0) {
    return { model: null, reason: "invalid-invariant-parameters" };
  }
  if (state.fee < 0n || state.fee >= CURVE_STABLESWAP_FEE_DENOMINATOR || state.offpegFeeMultiplier <= 0n) {
    return { model: null, reason: "invalid-invariant-parameters" };
  }
  // StableSwap-NG charges `fee` on balance and scales toward
  // `fee * offpeg_fee_multiplier / 1e10` off balance. The closed-form model
  // takes one fixed fee, so the capture carries the off-balance maximum: an
  // upper bound on fee is a lower bound on exit capacity, matching the bound
  // the reviewed rate-bearing path already publishes.
  const feeMultiplier =
    state.offpegFeeMultiplier > CURVE_STABLESWAP_FEE_DENOMINATOR
      ? Number(state.offpegFeeMultiplier) / Number(CURVE_STABLESWAP_FEE_DENOMINATOR)
      : 1;
  const feeRate = (Number(state.fee) / Number(CURVE_STABLESWAP_FEE_DENOMINATOR)) * feeMultiplier;
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    return { model: null, reason: "invalid-invariant-parameters" };
  }

  const balances = state.balances.map((balance, index) => toTokenUnits(balance, state.decimals[index]!));
  if (balances.some((balance) => balance == null)) {
    return { model: null, reason: "incomplete-exact-capture" };
  }
  const assetIds = state.coins.map((address) =>
    input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, address)),
  );
  const trackedResolution = resolveUniqueTrackedTokenIndex(assetIds, input.stablecoinId);
  if (trackedResolution.trackedTokenIndex === null) return { model: null, reason: trackedResolution.reason };
  const { trackedTokenIndex } = trackedResolution;

  const trustedPriceByIndex = assetIds.map((assetId) => {
    if (!assetId) return null;
    const price = input.stablecoinPriceById.get(assetId);
    return Number.isFinite(price) && price! > 0 ? price! : null;
  });
  let trackedReferencePrice = trustedPriceByIndex[trackedTokenIndex];
  // Weak/single-source quotes never enter stablecoinPriceById. A unique
  // authoritative counter-asset still sizes the tracked input from same-block
  // balances, the same inverse imply the reviewed V2 capture uses.
  if (trackedReferencePrice == null) {
    const pricedOthers = trustedPriceByIndex.flatMap((price, index) =>
      index !== trackedTokenIndex && price != null ? [{ index, price }] : [],
    );
    if (pricedOthers.length !== 1) return { model: null, reason: "incomplete-exact-capture" };
    const other = pricedOthers[0]!;
    const implied = (balances[other.index]! * other.price) / balances[trackedTokenIndex]!;
    if (!Number.isFinite(implied) || implied <= 0) return { model: null, reason: "incomplete-exact-capture" };
    trackedReferencePrice = implied;
  }

  const tokens = state.coins.map((address, index) => {
    const referencePriceUsd = index === trackedTokenIndex ? trackedReferencePrice! : trustedPriceByIndex[index];
    if (referencePriceUsd == null || !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) return null;
    const assetId = assetIds[index];
    return {
      address,
      symbol: state.symbols[index]!,
      decimals: state.decimals[index]!,
      balance: balances[index]!,
      referencePriceUsd,
      referencePriceSource: "source-token-usd" as const,
      ...(assetId ? { trackedAssetId: assetId } : {}),
    };
  });
  if (tokens.some((token) => token == null)) {
    return { model: null, reason: "incomplete-exact-capture" };
  }

  return {
    model: {
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex,
      feeRate,
      amplification,
      tokens: tokens as NonNullable<typeof tokens[number]>[],
    },
    reason: "incomplete-exact-capture",
  };
}

async function readIndexedPools(input: {
  deployment: CurveStableswapFactoryDeployment;
  blockNumber: number;
  rpcOptions: Parameters<typeof fetchEvmMulticall3Aggregate3AtBlock>[3];
  signal?: AbortSignal;
  dependencies: CurveStableswapFactoryDependencies;
}): Promise<IndexedPool[] | null> {
  const { deployment } = input;
  const countResults = await input.dependencies.fetchMulticall(
    deployment.chain,
    [
      {
        label: "pool-count",
        target: deployment.factoryAddress,
        callData: encodeFunctionData({ abi: CURVE_FACTORY_ABI, functionName: "pool_count" }),
      },
    ],
    input.blockNumber,
    input.rpcOptions,
  );
  if (!countResults) return null;
  const poolCount = decodeUint256(resultMap(countResults).get("pool-count"));
  // A factory past the reviewed bound fails closed: a truncated inventory can
  // resolve the wrong physical pool, and a wrong pool is worse than no route.
  if (poolCount == null || poolCount <= 0n || poolCount > BigInt(deployment.maxIndexedPools)) return null;

  const listResults = await runMulticallRounds({
    chain: deployment.chain,
    calls: Array.from({ length: Number(poolCount) }, (_, index) => ({
      label: `pool-list-${index}`,
      target: deployment.factoryAddress,
      callData: encodeFunctionData({
        abi: CURVE_FACTORY_ABI,
        functionName: "pool_list",
        args: [BigInt(index)],
      }),
    })),
    blockNumber: input.blockNumber,
    rpcOptions: input.rpcOptions,
    signal: input.signal,
    dependencies: input.dependencies,
  });
  if (!listResults) return null;
  const addresses: { index: number; address: `0x${string}` }[] = [];
  for (let index = 0; index < Number(poolCount); index++) {
    const address = decodeAddress(deployment.chain, listResults.get(`pool-list-${index}`));
    if (!address) return null;
    addresses.push({ index, address });
  }

  const coinResults = await runMulticallRounds({
    chain: deployment.chain,
    calls: addresses.map(({ index, address }) => ({
      label: `pool-coins-${index}`,
      target: deployment.factoryAddress,
      callData: encodeFunctionData({ abi: CURVE_FACTORY_ABI, functionName: "get_coins", args: [address] }),
    })),
    blockNumber: input.blockNumber,
    rpcOptions: input.rpcOptions,
    signal: input.signal,
    dependencies: input.dependencies,
  });
  if (!coinResults) return null;
  const indexed: IndexedPool[] = [];
  for (const { index, address } of addresses) {
    const coins = decodeAddressArray(deployment.chain, coinResults.get(`pool-coins-${index}`));
    if (!coins || coins.length < 2 || coins.length > MAX_POOL_COINS) continue;
    indexed.push({ index, address, coins });
  }
  return indexed;
}

async function readPoolState(input: {
  deployment: CurveStableswapFactoryDeployment;
  pool: IndexedPool;
  blockNumber: number;
  rpcOptions: Parameters<typeof fetchEvmMulticall3Aggregate3AtBlock>[3];
  signal?: AbortSignal;
  dependencies: CurveStableswapFactoryDependencies;
}): Promise<FactoryPoolState | null> {
  const { deployment, pool } = input;
  const factoryCall = (label: string, functionName: "get_decimals" | "get_balances" | "get_A" | "is_meta" | "get_implementation_address") => ({
    label,
    target: deployment.factoryAddress,
    callData: encodeFunctionData({ abi: CURVE_FACTORY_ABI, functionName, args: [pool.address] }),
  });
  const results = await runMulticallRounds({
    chain: deployment.chain,
    calls: [
      factoryCall("decimals", "get_decimals"),
      factoryCall("balances", "get_balances"),
      factoryCall("amplification", "get_A"),
      factoryCall("is-meta", "is_meta"),
      factoryCall("implementation", "get_implementation_address"),
      {
        label: "fee",
        target: pool.address,
        callData: encodeFunctionData({ abi: CURVE_POOL_ABI, functionName: "fee" }),
      },
      {
        label: "offpeg-fee-multiplier",
        target: pool.address,
        callData: encodeFunctionData({ abi: CURVE_POOL_ABI, functionName: "offpeg_fee_multiplier" }),
      },
      {
        label: "stored-rates",
        target: pool.address,
        callData: encodeFunctionData({ abi: CURVE_POOL_ABI, functionName: "stored_rates" }),
      },
      ...pool.coins.map((coin, index) => ({
        label: `symbol-${index}`,
        target: coin,
        callData: encodeFunctionData({ abi: ERC20_SYMBOL_ABI, functionName: "symbol" }),
      })),
    ],
    blockNumber: input.blockNumber,
    rpcOptions: input.rpcOptions,
    signal: input.signal,
    dependencies: input.dependencies,
  });
  if (!results) return null;

  // The factory must still claim this pool as a plain pool built from the
  // reviewed blueprint; a metapool or a foreign implementation is a different
  // model and is refused here rather than approximated.
  if (decodeBool(results.get("is-meta")) !== false) return null;
  const implementation = decodeAddress(deployment.chain, results.get("implementation"));
  if (!implementation || implementation !== deployment.expectedPoolImplementationAddress) return null;

  const decimals = decodeUint256Array(results.get("decimals"));
  const balances = decodeUint256Array(results.get("balances"));
  const amplification = decodeUint256(results.get("amplification"));
  const fee = decodeUint256(results.get("fee"));
  const offpegFeeMultiplier = decodeUint256(results.get("offpeg-fee-multiplier"));
  const storedRates = decodeUint256Array(results.get("stored-rates"));
  if (
    !decimals ||
    !balances ||
    !storedRates ||
    amplification == null ||
    fee == null ||
    offpegFeeMultiplier == null ||
    decimals.length !== pool.coins.length ||
    balances.length !== pool.coins.length ||
    storedRates.length !== pool.coins.length ||
    balances.some((balance) => balance <= 0n)
  ) {
    return null;
  }
  const symbols = pool.coins.map((_, index) => decodeString(results.get(`symbol-${index}`)));
  if (symbols.some((symbol) => symbol == null)) return null;

  return {
    address: pool.address,
    coins: pool.coins,
    decimals: decimals.map((value) => Number(value)),
    balances,
    amplification,
    fee,
    offpegFeeMultiplier,
    storedRates,
    symbols: symbols as string[],
  };
}

async function enrichDeployment(input: {
  deployment: CurveStableswapFactoryDeployment;
  references: FactoryReference[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  nowSec: number;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
  dependencies: CurveStableswapFactoryDependencies;
}): Promise<void> {
  const { deployment } = input;
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 15_000,
    maxRetries: 0,
  };

  const blockNumber = await input.dependencies.fetchBlockNumber(deployment.chain, rpcOptions);
  if (blockNumber == null) return;
  const header = await input.dependencies.fetchBlockHeader(deployment.chain, blockNumber, rpcOptions);
  if (!header || header.number !== blockNumber || !isFreshHeader(header, input.nowSec)) return;

  const factoryCode = await input.dependencies.fetchCodeAtBlock(
    deployment.chain,
    deployment.factoryAddress,
    blockNumber,
    rpcOptions,
  );
  if (!factoryCode || input.dependencies.hashCode(factoryCode) !== deployment.expectedFactoryCodeHash) return;
  const implementationCode = await input.dependencies.fetchCodeAtBlock(
    deployment.chain,
    deployment.expectedPoolImplementationAddress,
    blockNumber,
    rpcOptions,
  );
  if (
    !implementationCode ||
    input.dependencies.hashCode(implementationCode) !== deployment.expectedPoolImplementationCodeHash
  ) {
    return;
  }

  const indexed = await readIndexedPools({
    deployment,
    blockNumber,
    rpcOptions,
    signal: input.signal,
    dependencies: input.dependencies,
  });
  if (!indexed) return;

  const stateByPool = new Map<`0x${string}`, FactoryPoolState | null>();
  for (const reference of input.references) {
    throwIfAborted(input.signal);
    const matches = indexed.filter((candidate) =>
      candidate.coins.some(
        (coin) =>
          input.chainAddressToId.get(canonicalExitRouteAssetKey(deployment.chain, coin)) === reference.stablecoinId,
      ),
    );
    // The factory index is the join. Zero matches leaves the original
    // unresolved gate; more than one physical pool holding the same tracked
    // token is an ambiguity this stage refuses to break on TVL.
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      gateReference(reference, "ambiguous-token-identity");
      continue;
    }
    const match = matches[0]!;
    if (!stateByPool.has(match.address)) {
      stateByPool.set(
        match.address,
        await readPoolState({
          deployment,
          pool: match,
          blockNumber,
          rpcOptions,
          signal: input.signal,
          dependencies: input.dependencies,
        }),
      );
    }
    const state = stateByPool.get(match.address) ?? null;
    if (!state) {
      gateReference(reference, "incomplete-exact-capture");
      continue;
    }
    const built = buildCurveStableswapFactoryExecutionModel({
      chain: deployment.chain,
      stablecoinId: reference.stablecoinId,
      state,
      chainAddressToId: input.chainAddressToId,
      stablecoinPriceById: input.stablecoinPriceById,
    });
    if (!built.model) {
      gateReference(reference, built.reason);
      continue;
    }
    const extra = { ...(reference.pool.extra ?? {}) };
    delete extra.executionCapabilityGate;
    extra.ammExecutionModel = built.model;
    extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
    extra.registryId = deployment.registryId;
    extra.isMetaPool = false;
    reference.pool.extra = extra;
  }

  const confirmedHeader = await input.dependencies.fetchBlockHeader(deployment.chain, blockNumber, rpcOptions);
  if (
    !confirmedHeader ||
    confirmedHeader.number !== header.number ||
    confirmedHeader.hash.toLowerCase() !== header.hash.toLowerCase() ||
    !isFreshHeader(confirmedHeader, input.nowSec)
  ) {
    // The capture straddled a reorg or went stale mid-read; withdraw every
    // model this run published and restore the unresolved join.
    for (const reference of input.references) {
      const extra = { ...(reference.pool.extra ?? {}) };
      delete extra.ammExecutionModel;
      extra.executionCapabilityGate = { family: "curve-stableswap", reason: "exact-pool-join-unresolved" };
      reference.pool.extra = extra;
    }
  }
}

/**
 * Resolve Curve StableSwap-NG rows whose physical pool the source-only join
 * could not reach, using the pinned factory as the join and the sole state
 * authority, at one fresh confirmed block. Every failure keeps a Curve gate;
 * nothing here can publish a model on a factory or blueprint whose runtime
 * code hash has moved.
 */
export async function enrichCurveStableswapFactoryExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  nowSec?: number;
  dependencies?: CurveStableswapFactoryDependencies;
}): Promise<void> {
  if (!input.chainRpcs) return;
  const deployments = new Map(
    CURVE_STABLESWAP_FACTORY_DEPLOYMENTS.map((deployment) => [deployment.chain, deployment]),
  );
  const referencesByChain = new Map<string, FactoryReference[]>();
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      if (!isUnresolvedCurveStableswapJoin(pool) || hasScoreFacingMeasuredExecution(pool)) continue;
      if (normalizeProtocol(pool.project.trim().toLowerCase()) !== "curve") continue;
      const chain = canonicalExitRouteChain(pool.chain);
      if (!deployments.has(chain)) continue;
      referencesByChain.set(chain, [...(referencesByChain.get(chain) ?? []), { stablecoinId, pool }]);
    }
  }
  if (referencesByChain.size === 0) return;

  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  for (const [chain, references] of referencesByChain) {
    try {
      await enrichDeployment({
        deployment: deployments.get(chain)!,
        references,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        nowSec,
        chainAddressToId: input.chainAddressToId,
        stablecoinPriceById: input.stablecoinPriceById,
        dependencies,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      for (const reference of references) gateReference(reference, "exact-pool-join-unresolved");
    }
  }
}
