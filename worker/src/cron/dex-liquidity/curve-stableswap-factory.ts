import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/lib/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { toTokenUnits } from "@shared/lib/math";
import { encodeFunctionData, keccak256, parseAbi } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  curveAmplificationFromContract,
  curveConservativeFeeRate,
  decodeEvmCaptureAddress,
  decodeEvmCaptureAddressArray,
  decodeEvmCaptureBool,
  decodeEvmCaptureString,
  decodeEvmCaptureUint256,
  decodeEvmCaptureUint256Array,
  mapEvmCaptureResults,
  resolveTrackedReferencePrices,
  runPinnedBlockCapture,
} from "./evm-capture-helpers";
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
  return mapEvmCaptureResults(collected);
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
}): { ok: true; model: DexAmmExecutionModel } | { ok: false; reason: CurveGateReason } {
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
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  if (new Set(state.coins).size !== tokenCount) {
    return { ok: false, reason: "ambiguous-token-identity" };
  }
  for (let index = 0; index < tokenCount; index++) {
    const decimals = state.decimals[index]!;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return { ok: false, reason: "incomplete-exact-capture" };
    }
    if (state.storedRates[index] !== 10n ** BigInt(36 - decimals)) {
      return { ok: false, reason: "rate-bearing-inputs" };
    }
  }
  const amplification = curveAmplificationFromContract(state.amplification, tokenCount);
  if (amplification == null) {
    return { ok: false, reason: "invalid-invariant-parameters" };
  }
  // The shared closed-form model carries the off-balance maximum so its fee
  // remains a conservative lower bound on exit capacity.
  const feeRate =
    state.offpegFeeMultiplier > 0n
      ? curveConservativeFeeRate(state.fee, state.offpegFeeMultiplier)
      : null;
  if (feeRate == null) {
    return { ok: false, reason: "invalid-invariant-parameters" };
  }

  const balances = state.balances.map((balance, index) => toTokenUnits(balance, state.decimals[index]!));
  if (balances.some((balance) => balance == null)) {
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  const assetIds = state.coins.map((address) =>
    input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, address)),
  );
  const trackedResolution = resolveUniqueTrackedTokenIndex(assetIds, input.stablecoinId);
  if (trackedResolution.trackedTokenIndex === null) return { ok: false, reason: trackedResolution.reason };
  const { trackedTokenIndex } = trackedResolution;

  const resolvedPrices = resolveTrackedReferencePrices({
    balances: balances as number[],
    assetIds,
    trackedTokenIndex,
    stablecoinPriceById: input.stablecoinPriceById,
    implyUntrackedPrices: false,
  });
  if (!resolvedPrices.ok) return { ok: false, reason: "incomplete-exact-capture" };

  const tokens = state.coins.map((address, index) => {
    const referencePriceUsd = resolvedPrices.value.prices[index];
    if (referencePriceUsd == null) return null;
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
    return { ok: false, reason: "incomplete-exact-capture" };
  }

  return {
    ok: true,
    model: {
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex,
      feeRate,
      amplification,
      tokens: tokens as NonNullable<typeof tokens[number]>[],
    },
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
  const poolCount = decodeEvmCaptureUint256(mapEvmCaptureResults(countResults).get("pool-count"));
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
    const address = decodeEvmCaptureAddress(deployment.chain, listResults.get(`pool-list-${index}`));
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
    const coins = decodeEvmCaptureAddressArray(deployment.chain, coinResults.get(`pool-coins-${index}`));
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
  if (decodeEvmCaptureBool(results.get("is-meta")) !== false) return null;
  const implementation = decodeEvmCaptureAddress(deployment.chain, results.get("implementation"));
  if (!implementation || implementation !== deployment.expectedPoolImplementationAddress) return null;

  const decimals = decodeEvmCaptureUint256Array(results.get("decimals"));
  const balances = decodeEvmCaptureUint256Array(results.get("balances"));
  const amplification = decodeEvmCaptureUint256(results.get("amplification"));
  const fee = decodeEvmCaptureUint256(results.get("fee"));
  const offpegFeeMultiplier = decodeEvmCaptureUint256(results.get("offpeg-fee-multiplier"));
  const storedRates = decodeEvmCaptureUint256Array(results.get("stored-rates"));
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
  const symbols = pool.coins.map((_, index) => decodeEvmCaptureString(results.get(`symbol-${index}`)));
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
  await runPinnedBlockCapture<Array<() => void>>({
    chain: deployment.chain,
    rpcOptions,
    fetchBlockNumber: input.dependencies.fetchBlockNumber,
    fetchBlockHeader: input.dependencies.fetchBlockHeader,
    nowSec: input.nowSec,
    maxAgeSec: CURVE_STABLESWAP_FACTORY_CAPTURE_MAX_AGE_SEC,
    verifyDeployment: async ({ blockNumber }) => {
      const factoryCode = await input.dependencies.fetchCodeAtBlock(
        deployment.chain,
        deployment.factoryAddress,
        blockNumber,
        rpcOptions,
      );
      if (!factoryCode || input.dependencies.hashCode(factoryCode) !== deployment.expectedFactoryCodeHash) {
        return { ok: false };
      }
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
        return { ok: false };
      }
      return { ok: true };
    },
    buildCalls: async ({ blockNumber }) => {
      const indexed = await readIndexedPools({
        deployment,
        blockNumber,
        rpcOptions,
        signal: input.signal,
        dependencies: input.dependencies,
      });
      if (!indexed) return { ok: false };

      const actions: Array<() => void> = [];
      const stateByPool = new Map<`0x${string}`, FactoryPoolState | null>();
      for (const reference of input.references) {
        throwIfAborted(input.signal);
        const matches = indexed.filter((candidate) =>
          candidate.coins.some(
            (coin) =>
              input.chainAddressToId.get(canonicalExitRouteAssetKey(deployment.chain, coin)) ===
              reference.stablecoinId,
          ),
        );
        if (matches.length === 0) continue;
        if (matches.length > 1) {
          actions.push(() => gateReference(reference, "ambiguous-token-identity"));
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
          actions.push(() => gateReference(reference, "incomplete-exact-capture"));
          continue;
        }
        const built = buildCurveStableswapFactoryExecutionModel({
          chain: deployment.chain,
          stablecoinId: reference.stablecoinId,
          state,
          chainAddressToId: input.chainAddressToId,
          stablecoinPriceById: input.stablecoinPriceById,
        });
        if (!built.ok) {
          actions.push(() => gateReference(reference, built.reason));
          continue;
        }
        actions.push(() => {
          const extra = { ...(reference.pool.extra ?? {}) };
          delete extra.executionCapabilityGate;
          extra.ammExecutionModel = built.model;
          extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
          extra.registryId = deployment.registryId;
          extra.isMetaPool = false;
          reference.pool.extra = extra;
        });
      }
      return { ok: true, value: actions };
    },
    onResults: (actions) => {
      for (const apply of actions) apply();
    },
    onFailure: () => undefined,
  });
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
