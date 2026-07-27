import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import type { DexAmmExecutionModel } from "@shared/types/market";
import { decodeAbiParameters, encodeFunctionData, parseAbi } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmBlockHeader,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import type {
  CurveStableswapRateInputExecutionCandidate,
  LiquidityMetrics,
  PoolEntry,
  SymbolLookups,
} from "./types";

/**
 * The Curve pools endpoint does not publish per-pool fees. Standard
 * StableSwap pools charge 1-4 bps; this conservative upper bound keeps the
 * modeled output below the live route when the source fee is unavailable.
 */
export const CURVE_STABLESWAP_FEE_BOUND = 0.001;
/** A source-stage capture must reflect the current head, not a reusable quote profile. */
export const CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC = 10 * 60;

const CURVE_STABLESWAP_NG_ABI = parseAbi([
  "function get_balances() view returns (uint256[])",
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function coins(uint256) view returns (address)",
]);
const MAX_PROBES_PER_MULTICALL = 4;

interface CurveStableswapRateDependencies {
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
}

const DEFAULT_DEPENDENCIES: CurveStableswapRateDependencies = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockHeader: fetchEvmBlockHeader,
  fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock,
};

interface CandidateReference {
  stablecoinId: string;
  pool: PoolEntry;
  candidate: CurveStableswapRateInputExecutionCandidate;
}

interface CurveRateProbe {
  candidate: CurveStableswapRateInputExecutionCandidate;
  references: CandidateReference[];
  incompatibleLayout: boolean;
}

interface CurveRatePoolState {
  balances: bigint[];
  rates: bigint[];
  amplification: bigint;
  coinAddresses: `0x${string}`[];
}

function asEvmAddress(chain: string, value: string | null | undefined): `0x${string}` | null {
  const normalized = canonicalExitRouteScopedId(chain, value ?? "");
  return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

function isRateBearingGate(pool: PoolEntry): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "curve-stableswap" && gate.reason === "rate-bearing-inputs";
}

function hasScoreFacingMeasuredExecution(pool: PoolEntry): boolean {
  const extra = pool.extra;
  return Boolean(
    extra?.measuredExecutionTarget ||
      extra?.measuredExecutionTargets?.length ||
      extra?.measuredExecution ||
      extra?.measuredExecutions?.length ||
      extra?.measuredExecutionProfile ||
      extra?.measuredExecutionProfiles?.length,
  );
}

function clearCandidate(reference: CandidateReference): void {
  if (!reference.pool.extra) return;
  delete reference.pool.extra.curveStableswapRateInputExecutionCandidate;
}

function clearProbe(probe: CurveRateProbe): void {
  for (const reference of probe.references) clearCandidate(reference);
}

function sameCoinLayout(
  left: CurveStableswapRateInputExecutionCandidate,
  right: CurveStableswapRateInputExecutionCandidate,
): boolean {
  return (
    left.poolAddress === right.poolAddress &&
    left.coins.length === right.coins.length &&
    left.coins.every((coin, index) => {
      const other = right.coins[index];
      return other != null && coin.address === other.address && coin.decimals === other.decimals;
    })
  );
}

function resultMap(results: readonly EvmMulticall3Result[]): Map<string, EvmMulticall3Result> {
  return new Map(results.map((result) => [result.label, result]));
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

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "uint256" }], result.returnData);
    return value;
  } catch {
    return null;
  }
}

function decodeAddress(
  chain: string,
  result: EvmMulticall3Result | undefined,
): `0x${string}` | null {
  if (!result?.success) return null;
  try {
    const [address] = decodeAbiParameters([{ type: "address" }], result.returnData);
    return asEvmAddress(chain, address);
  } catch {
    return null;
  }
}

function parsePoolState(input: {
  chain: string;
  probe: CurveRateProbe;
  index: number;
  results: Map<string, EvmMulticall3Result>;
}): CurveRatePoolState | null {
  const prefix = `curve-rate-${input.index}`;
  const balances = decodeUint256Array(input.results.get(`${prefix}-balances`));
  const rates = decodeUint256Array(input.results.get(`${prefix}-rates`));
  const amplification = decodeUint256(input.results.get(`${prefix}-A`));
  const expectedCoins = input.probe.candidate.coins;
  if (
    !balances ||
    !rates ||
    amplification == null ||
    amplification <= 0n ||
    balances.length !== expectedCoins.length ||
    rates.length !== expectedCoins.length ||
    balances.some((balance) => balance <= 0n) ||
    rates.some((rate) => rate <= 0n)
  ) {
    return null;
  }

  const coinAddresses: `0x${string}`[] = [];
  for (let coinIndex = 0; coinIndex < expectedCoins.length; coinIndex++) {
    const address = decodeAddress(input.chain, input.results.get(`${prefix}-coin-${coinIndex}`));
    if (!address || address !== expectedCoins[coinIndex]!.address) return null;
    coinAddresses.push(address);
  }
  return { balances, rates, amplification, coinAddresses };
}

function toTokenUnits(value: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value <= 0n) return null;
  const amount = Number(value) / 10 ** decimals;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function rateFactor(rate: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || rate <= 0n) return null;
  const baseRate = 10n ** BigInt(36 - decimals);
  const factor = Number(rate) / Number(baseRate);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

function buildRateAwareExecutionModel(input: {
  chain: string;
  stablecoinId: string;
  candidate: CurveStableswapRateInputExecutionCandidate;
  state: CurveRatePoolState;
  chainAddressToId: SymbolLookups["chainAddressToId"];
}): DexAmmExecutionModel | null {
  const { candidate, state } = input;
  const tokenCount = candidate.coins.length;
  if (tokenCount < 2 || tokenCount > 8) return null;
  // Curve NG A() exposes the contract convention (Ann = A_contract * n).
  // The shared simulator uses the plain paper convention (Ann = A * n^n).
  const amplification = Number(state.amplification) / tokenCount ** (tokenCount - 1);
  if (!Number.isFinite(amplification) || amplification <= 0) return null;

  let hasNonBaseRate = false;
  const tokens = candidate.coins.map((coin, index) => {
    if (!Number.isInteger(coin.decimals) || coin.decimals < 0 || coin.decimals > 36) return null;
    const balance = toTokenUnits(state.balances[index]!, coin.decimals);
    const factor = rateFactor(state.rates[index]!, coin.decimals);
    const baseRate = 10n ** BigInt(36 - coin.decimals);
    if (state.rates[index] !== baseRate) hasNonBaseRate = true;
    if (
      balance == null ||
      factor == null ||
      !Number.isFinite(coin.referencePriceUsd) ||
      coin.referencePriceUsd <= 0
    ) {
      return null;
    }
    const scaledBalance = balance * factor;
    const scaledReferencePrice = coin.referencePriceUsd / factor;
    if (
      !Number.isFinite(scaledBalance) ||
      scaledBalance <= 0 ||
      !Number.isFinite(scaledReferencePrice) ||
      scaledReferencePrice <= 0
    ) {
      return null;
    }
    const assetKey = canonicalExitRouteAssetKey(input.chain, state.coinAddresses[index]!);
    const trackedAssetId = input.chainAddressToId.get(assetKey);
    return {
      address: state.coinAddresses[index]!,
      symbol: coin.symbol,
      decimals: coin.decimals,
      balance: scaledBalance,
      referencePriceUsd: scaledReferencePrice,
      referencePriceSource: "source-token-usd" as const,
      ...(trackedAssetId ? { trackedAssetId } : {}),
    };
  });
  if (!hasNonBaseRate || tokens.some((token) => token == null)) return null;

  const exactTokens = tokens as NonNullable<typeof tokens[number]>[];
  const trackedIndexes = exactTokens
    .map((token, index) => (token.trackedAssetId === input.stablecoinId ? index : -1))
    .filter((index) => index >= 0);
  if (trackedIndexes.length !== 1) return null;
  const identities = exactTokens.map((token) => canonicalExitRouteAssetKey(input.chain, token.address));
  if (new Set(identities).size !== identities.length) return null;

  return {
    source: "curve",
    invariant: "stableswap",
    trackedTokenIndex: trackedIndexes[0]!,
    feeRate: CURVE_STABLESWAP_FEE_BOUND,
    amplification,
    tokens: exactTokens,
  };
}

function isFreshHeader(header: EvmBlockHeader, nowSec: number): boolean {
  return (
    Number.isSafeInteger(nowSec) &&
    header.timestamp <= nowSec + 60 &&
    nowSec - header.timestamp <= CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC
  );
}

function buildPoolCalls(probes: readonly CurveRateProbe[], offset: number) {
  return probes.flatMap((probe, batchIndex) => {
    const index = offset + batchIndex;
    const prefix = `curve-rate-${index}`;
    return [
      {
        label: `${prefix}-balances`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "get_balances" }),
      },
      {
        label: `${prefix}-rates`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "stored_rates" }),
      },
      {
        label: `${prefix}-A`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "A" }),
      },
      ...probe.candidate.coins.map((_, coinIndex) => ({
        label: `${prefix}-coin-${coinIndex}`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({
          abi: CURVE_STABLESWAP_NG_ABI,
          functionName: "coins",
          args: [BigInt(coinIndex)],
        }),
      })),
    ];
  });
}

async function enrichChain(input: {
  chain: string;
  probes: CurveRateProbe[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  nowSec: number;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  dependencies: CurveStableswapRateDependencies;
}): Promise<void> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 15_000,
    maxRetries: 0,
  };
  const blockNumber = await input.dependencies.fetchBlockNumber(input.chain, rpcOptions);
  if (blockNumber == null) {
    input.probes.forEach(clearProbe);
    return;
  }
  const header = await input.dependencies.fetchBlockHeader(input.chain, blockNumber, rpcOptions);
  if (!header || header.number !== blockNumber || !isFreshHeader(header, input.nowSec)) {
    input.probes.forEach(clearProbe);
    return;
  }

  const states = new Map<CurveRateProbe, CurveRatePoolState | null>();
  for (let start = 0; start < input.probes.length; start += MAX_PROBES_PER_MULTICALL) {
    throwIfAborted(input.signal);
    const probes = input.probes.slice(start, start + MAX_PROBES_PER_MULTICALL);
    const results = await input.dependencies.fetchMulticall(
      input.chain,
      buildPoolCalls(probes, start),
      blockNumber,
      rpcOptions,
    );
    if (!results) {
      input.probes.forEach(clearProbe);
      return;
    }
    const byLabel = resultMap(results);
    for (let batchIndex = 0; batchIndex < probes.length; batchIndex++) {
      const probe = probes[batchIndex]!;
      states.set(
        probe,
        probe.incompatibleLayout
          ? null
          : parsePoolState({ chain: input.chain, probe, index: start + batchIndex, results: byLabel }),
      );
    }
  }

  const confirmedHeader = await input.dependencies.fetchBlockHeader(input.chain, blockNumber, rpcOptions);
  if (
    !confirmedHeader ||
    confirmedHeader.number !== header.number ||
    confirmedHeader.hash.toLowerCase() !== header.hash.toLowerCase() ||
    !isFreshHeader(confirmedHeader, input.nowSec)
  ) {
    input.probes.forEach(clearProbe);
    return;
  }

  for (const probe of input.probes) {
    const state = states.get(probe);
    if (!state) {
      clearProbe(probe);
      continue;
    }
    for (const reference of probe.references) {
      const model = buildRateAwareExecutionModel({
        chain: input.chain,
        stablecoinId: reference.stablecoinId,
        candidate: reference.candidate,
        state,
        chainAddressToId: input.chainAddressToId,
      });
      if (!model) {
        clearCandidate(reference);
        continue;
      }
      const extra = { ...(reference.pool.extra ?? {}) };
      delete extra.curveStableswapRateInputExecutionCandidate;
      delete extra.executionCapabilityGate;
      extra.ammExecutionModel = model;
      extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
      reference.pool.extra = extra;
    }
  }
}

/**
 * Replace eligible Curve StableSwap-NG rate-bearing gates only after reading
 * balances, rate multipliers, amplification, and coin order at one fresh,
 * confirmed block. Every failure keeps the original rate-bearing gate.
 */
export async function enrichCurveStableswapRateInputExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  nowSec?: number;
  dependencies?: CurveStableswapRateDependencies;
}): Promise<void> {
  const references: CandidateReference[] = [];
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      const candidate = pool.extra?.curveStableswapRateInputExecutionCandidate;
      if (!candidate) continue;
      const reference = { stablecoinId, pool, candidate };
      if (isRateBearingGate(pool) && !hasScoreFacingMeasuredExecution(pool)) references.push(reference);
      else clearCandidate(reference);
    }
  }
  if (references.length === 0) return;
  if (!input.chainRpcs) {
    for (const reference of references) clearCandidate(reference);
    return;
  }

  const probesByChain = new Map<string, Map<string, CurveRateProbe>>();
  for (const reference of references) {
    const chain = canonicalExitRouteChain(reference.pool.chain);
    const poolAddress = asEvmAddress(chain, reference.candidate.poolAddress);
    if (!poolAddress || poolAddress !== reference.candidate.poolAddress) {
      clearCandidate(reference);
      continue;
    }
    const probes = probesByChain.get(chain) ?? new Map<string, CurveRateProbe>();
    const existing = probes.get(poolAddress);
    if (existing) {
      existing.incompatibleLayout ||= !sameCoinLayout(existing.candidate, reference.candidate);
      existing.references.push(reference);
    } else {
      probes.set(poolAddress, {
        candidate: reference.candidate,
        references: [reference],
        incompatibleLayout: false,
      });
    }
    probesByChain.set(chain, probes);
  }

  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  for (const [chain, probes] of probesByChain) {
    try {
      await enrichChain({
        chain,
        probes: [...probes.values()],
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        nowSec,
        chainAddressToId: input.chainAddressToId,
        dependencies,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      for (const probe of probes.values()) clearProbe(probe);
    }
  }
}
