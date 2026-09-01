import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { decodeAbiParameters, keccak256 } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR, encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import { buildPoolFingerprint, normalizeProtocol } from "./pool-helpers";
import { resolveUniqueTrackedTokenIndex } from "./scoring-helpers";
import type { EvmV2ExecutionCandidate, LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";

const GET_PAIR_SELECTOR = "0xe6a43905";
const AERODROME_GET_POOL_SELECTOR = "0x79bc57d5";
const AERODROME_IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const AERODROME_IS_PAUSED_SELECTOR = "0xb187bd26";
const AERODROME_GET_FEE_SELECTOR = "0xcc56b2c5";
const AERODROME_STABLE_SELECTOR = "0x22be3de1";
const TOKEN_0_SELECTOR = "0x0dfe1681";
const TOKEN_1_SELECTOR = "0xd21220a7";
const GET_RESERVES_SELECTOR = "0x0902f1ac";
const MAX_PROBES_PER_MULTICALL = 4;
const AERODROME_MAX_FEE_BPS = 300n;

type EvmV2Source = EvmV2ExecutionCandidate["source"];
type V2GateReason = DexExecutionCapabilityGate["reason"];

interface EvmV2DeploymentBase {
  source: EvmV2Source;
  chain: "ethereum" | "bsc" | "base";
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
}

type EvmV2Deployment =
  | (EvmV2DeploymentBase & {
      binding: "get-pair";
      source: "uniswap-v2" | "pancakeswap-v2";
      chain: "ethereum" | "bsc";
      feeRate: number;
    })
  | (EvmV2DeploymentBase & {
      binding: "aerodrome-volatile";
      source: "aerodrome-volatile";
      chain: "base";
      expectedImplementationAddress: `0x${string}`;
      expectedImplementationCodeHash: `0x${string}`;
    });

/**
 * Canonical factories and runtime hashes verified from the deployed contracts.
 * A pool is accepted only when this exact factory also resolves its token pair
 * to the candidate address at the reserve-read block.
 */
export const EVM_V2_EXECUTION_DEPLOYMENTS: readonly EvmV2Deployment[] = [
  {
    source: "uniswap-v2",
    chain: "ethereum",
    binding: "get-pair",
    factoryAddress: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    expectedFactoryCodeHash: "0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0",
    feeRate: 0.003,
  },
  {
    source: "pancakeswap-v2",
    chain: "bsc",
    binding: "get-pair",
    factoryAddress: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
    expectedFactoryCodeHash: "0x9e8d17faaee69b053be6ac65b2b2c317741d770cb5fbdd9512536d17e9e076ca",
    feeRate: 0.0025,
  },
  {
    source: "aerodrome-volatile",
    chain: "base",
    binding: "aerodrome-volatile",
    factoryAddress: "0x420dd381b31aef6683db6b902084cb0ffece40da",
    expectedFactoryCodeHash: "0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3",
    expectedImplementationAddress: "0xa4e46b4f701c62e14df11b48dce76a7d793cd6d7",
    expectedImplementationCodeHash: "0xd22754a0a3b39db7298dbbc2be1e34b34320988ea67065c85fa28ae66c02d31e",
  },
] as const;

interface EvmV2ExecutionDependencies {
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
  hashCode: (code: `0x${string}`) => `0x${string}`;
}

const DEFAULT_DEPENDENCIES: EvmV2ExecutionDependencies = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchCodeAtBlock: fetchEvmCodeAtBlock,
  fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock,
  hashCode: keccak256,
};

function asEvmAddress(chain: string, value: string | null | undefined): `0x${string}` | null {
  const normalized = canonicalExitRouteScopedId(chain, value ?? "");
  return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

function isConcentratedOrStableFamily(value: string): boolean {
  return /(v3|v4|concentrated|\bclmm\b|\bcg-cl-|stable)/.test(value.toLowerCase());
}

export function buildEvmV2ExecutionCandidate(input: {
  chain: string;
  protocol: string;
  poolType: string;
  poolAddress: string;
  tokenAddresses: readonly string[];
  tokenSymbols?: readonly string[];
  /** Required census evidence for the reviewed classic Aerodrome deployment. */
  confirmedStable?: boolean;
}): EvmV2ExecutionCandidate | null {
  const chain = canonicalExitRouteChain(input.chain);
  const protocol = input.protocol.trim().toLowerCase();
  const normalizedProtocol = normalizeProtocol(protocol);
  const familyDescriptor = `${protocol} ${input.poolType}`.toLowerCase();

  let source: EvmV2Source;
  if (chain === "ethereum" && normalizedProtocol === "uniswap-v2" && !isConcentratedOrStableFamily(familyDescriptor)) {
    source = "uniswap-v2";
  } else if (
    chain === "bsc" &&
    normalizedProtocol === "pancakeswap" &&
    !isConcentratedOrStableFamily(familyDescriptor)
  ) {
    source = "pancakeswap-v2";
  } else if (
    chain === "base" &&
    protocol === "aerodrome" &&
    input.poolType.toLowerCase() === "aerodrome-volatile" &&
    input.confirmedStable === false
  ) {
    source = "aerodrome-volatile";
  } else {
    return null;
  }

  if (input.tokenAddresses.length !== 2) return null;
  const poolAddress = asEvmAddress(chain, input.poolAddress);
  const token0 = asEvmAddress(chain, input.tokenAddresses[0]);
  const token1 = asEvmAddress(chain, input.tokenAddresses[1]);
  if (!poolAddress || !token0 || !token1 || token0 === token1) return null;

  const symbols = input.tokenSymbols?.length === 2 ? input.tokenSymbols.map((symbol) => symbol.trim()) : [];
  return {
    source,
    poolAddress,
    tokenAddresses: [token0, token1],
    tokenSymbols: [symbols[0] || token0, symbols[1] || token1],
  };
}

export type UniqueEvmV2ExecutionCandidateFingerprintIndex = Map<
  string,
  EvmV2ExecutionCandidate | null
>;

/**
 * Index reviewed exact candidates by their canonical token fingerprint.
 *
 * A null value is an explicit ambiguity marker. The exact-address map remains
 * authoritative; this index exists only for retained providers such as
 * DeFiLlama that identify the same pool with a UUID instead of its address.
 */
export function buildUniqueEvmV2ExecutionCandidateFingerprintIndex(
  candidates: ReadonlyMap<string, EvmV2ExecutionCandidate>,
): UniqueEvmV2ExecutionCandidateFingerprintIndex {
  const index: UniqueEvmV2ExecutionCandidateFingerprintIndex = new Map();
  for (const [exactPoolKey, candidate] of candidates) {
    const separator = exactPoolKey.indexOf(":");
    if (separator <= 0) continue;
    const chain = canonicalExitRouteChain(exactPoolKey.slice(0, separator));
    if (canonicalExitRouteAssetKey(chain, candidate.poolAddress) !== exactPoolKey.trim().toLowerCase()) {
      continue;
    }
    const fingerprint = buildPoolFingerprint(chain, candidate.source, [...candidate.tokenAddresses]);
    if (!fingerprint) continue;
    if (index.has(fingerprint)) {
      index.set(fingerprint, null);
    } else {
      index.set(fingerprint, candidate);
    }
  }
  return index;
}

/** Resolve exact address first, then a unique same-family token fingerprint. */
export function resolveEvmV2ExecutionCandidate(input: {
  chain: string;
  protocol: string;
  poolAddressOrId: string;
  tokenAddresses: readonly string[];
  exactCandidates: ReadonlyMap<string, EvmV2ExecutionCandidate>;
  uniqueFingerprintCandidates: ReadonlyMap<string, EvmV2ExecutionCandidate | null>;
}): EvmV2ExecutionCandidate | undefined {
  const chain = canonicalExitRouteChain(input.chain);
  const exact = input.exactCandidates.get(canonicalExitRouteAssetKey(chain, input.poolAddressOrId));
  if (exact) return exact;
  if (input.tokenAddresses.length !== 2) return undefined;
  const fingerprint = buildPoolFingerprint(chain, input.protocol, [...input.tokenAddresses]);
  if (!fingerprint) return undefined;
  return input.uniqueFingerprintCandidates.get(fingerprint) ?? undefined;
}

/** Attach an exact staged candidate to a retained primary row deduped by its token fingerprint. */
export function attachEvmV2CandidateToRetainedPool(input: {
  metrics: Map<string, LiquidityMetrics>;
  stablecoinId: string;
  chain: string;
  candidate: EvmV2ExecutionCandidate;
}): boolean {
  const metric = input.metrics.get(input.stablecoinId);
  if (!metric) return false;
  const exactPoolId = canonicalExitRouteAssetKey(input.chain, input.candidate.poolAddress);
  const fingerprint = buildPoolFingerprint(input.chain, input.candidate.source, input.candidate.tokenAddresses);
  const retainedPool = metric.topPools.find(
    (pool) =>
      normalizeProtocol(pool.project) === normalizeProtocol(input.candidate.source) &&
      (pool.poolId === exactPoolId || (fingerprint != null && pool.poolId === fingerprint)),
  );
  if (!retainedPool || retainedPool.extra?.ammExecutionModel) return false;
  retainedPool.extra = {
    ...(retainedPool.extra ?? {}),
    evmV2ExecutionCandidate: input.candidate,
  };
  return true;
}

interface CandidateReference {
  stablecoinId: string;
  pool: PoolEntry;
  candidate: EvmV2ExecutionCandidate;
}

interface PairProbe {
  candidate: EvmV2ExecutionCandidate;
  references: CandidateReference[];
}

interface VerifiedPairState {
  tokenAddresses: [`0x${string}`, `0x${string}`];
  decimals: [number, number];
  balances: [number, number];
}

function deploymentKey(source: EvmV2Source, chain: string): string {
  return `${source}:${canonicalExitRouteChain(chain)}`;
}

function candidateKey(candidate: EvmV2ExecutionCandidate): string {
  return `${candidate.poolAddress}:${[...candidate.tokenAddresses].sort().join(":")}`;
}

function gateReference(reference: CandidateReference, reason: V2GateReason): void {
  const extra = { ...(reference.pool.extra ?? {}) };
  delete extra.ammExecutionModel;
  delete extra.evmV2ExecutionCandidate;
  extra.executionCapabilityGate = { family: "constant-product-v2", reason };
  reference.pool.extra = extra;
}

function clearCandidate(reference: CandidateReference): void {
  if (!reference.pool.extra) return;
  delete reference.pool.extra.evmV2ExecutionCandidate;
}

function decodeAddressResult(result: EvmMulticall3Result | undefined): `0x${string}` | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  const address = `0x${result.returnData.slice(-40).toLowerCase()}` as `0x${string}`;
  return /^0x0{40}$/.test(address) ? null : address;
}

function decodeDecimalsResult(result: EvmMulticall3Result | undefined): number | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  const value = BigInt(result.returnData);
  return value <= 255n ? Number(value) : null;
}

function decodeBoolResult(result: EvmMulticall3Result | undefined): boolean | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  const value = BigInt(result.returnData);
  return value === 0n ? false : value === 1n ? true : null;
}

function decodeUint256Result(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  return BigInt(result.returnData);
}

function decodeReservesResult(result: EvmMulticall3Result | undefined): [bigint, bigint] | null {
  // Both reviewed V2 pair families return exactly (reserve0, reserve1,
  // blockTimestampLast). Extra or truncated words are not a reserve proof.
  if (!result?.success || !/^0x[0-9a-fA-F]{192}$/.test(result.returnData)) return null;
  try {
    const [reserve0, reserve1] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      result.returnData,
    );
    return reserve0 > 0n && reserve1 > 0n ? [reserve0, reserve1] : null;
  } catch {
    return null;
  }
}

function resultMap(results: readonly EvmMulticall3Result[]): Map<string, EvmMulticall3Result> {
  return new Map(results.map((result) => [result.label, result]));
}

function parseVerifiedPairState(
  probe: PairProbe,
  index: number,
  results: Map<string, EvmMulticall3Result>,
): { state: VerifiedPairState | null; reason: V2GateReason } {
  const prefix = `v2-${index}`;
  const resolvedPair = decodeAddressResult(results.get(`${prefix}-pair`));
  if (resolvedPair !== probe.candidate.poolAddress) {
    return { state: null, reason: "exact-pool-join-unresolved" };
  }
  const token0 = decodeAddressResult(results.get(`${prefix}-token0`));
  const token1 = decodeAddressResult(results.get(`${prefix}-token1`));
  if (!token0 || !token1 || token0 === token1) {
    return { state: null, reason: "ambiguous-token-identity" };
  }
  const expectedTokens = new Set(probe.candidate.tokenAddresses);
  if (!expectedTokens.has(token0) || !expectedTokens.has(token1)) {
    return { state: null, reason: "ambiguous-token-identity" };
  }

  const decimalsByAddress = new Map<`0x${string}`, number>();
  const decimals0 = decodeDecimalsResult(results.get(`${prefix}-decimals0`));
  const decimals1 = decodeDecimalsResult(results.get(`${prefix}-decimals1`));
  if (decimals0 == null || decimals1 == null) {
    return { state: null, reason: "incomplete-exact-capture" };
  }
  decimalsByAddress.set(probe.candidate.tokenAddresses[0], decimals0);
  decimalsByAddress.set(probe.candidate.tokenAddresses[1], decimals1);
  const reserves = decodeReservesResult(results.get(`${prefix}-reserves`));
  const token0Decimals = decimalsByAddress.get(token0);
  const token1Decimals = decimalsByAddress.get(token1);
  if (!reserves || token0Decimals == null || token1Decimals == null) {
    return { state: null, reason: "incomplete-exact-capture" };
  }
  const balance0 = Number(reserves[0]) / 10 ** token0Decimals;
  const balance1 = Number(reserves[1]) / 10 ** token1Decimals;
  if (!Number.isFinite(balance0) || !Number.isFinite(balance1) || balance0 <= 0 || balance1 <= 0) {
    return { state: null, reason: "incomplete-exact-capture" };
  }
  return {
    state: {
      tokenAddresses: [token0, token1],
      decimals: [token0Decimals, token1Decimals],
      balances: [balance0, balance1],
    },
    reason: "incomplete-exact-capture",
  };
}

function buildExecutionModel(input: {
  reference: CandidateReference;
  deployment: EvmV2Deployment;
  feeRate: number;
  state: VerifiedPairState;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  stablecoinPriceById: Map<string, number>;
}): { model: DexAmmExecutionModel | null; reason: V2GateReason } {
  const { reference, state } = input;
  const assetIds = state.tokenAddresses.map((address) =>
    input.chainAddressToId.get(canonicalExitRouteAssetKey(input.deployment.chain, address)),
  );
  const trackedResolution = resolveUniqueTrackedTokenIndex(assetIds, reference.stablecoinId);
  if (trackedResolution.trackedTokenIndex === null) return { model: null, reason: trackedResolution.reason };
  const { trackedTokenIndex } = trackedResolution;
  const trustedPriceByIndex = assetIds.map((assetId) => {
    if (!assetId) return null;
    const price = input.stablecoinPriceById.get(assetId);
    return Number.isFinite(price) && price! > 0 ? price! : null;
  });
  let trackedReferencePrice = trustedPriceByIndex[trackedTokenIndex];
  let trackedReferenceSource: "tracked-market" | "pool-implied" = "tracked-market";
  // Weak/single-source quotes never enter stablecoinPriceById. A unique
  // authoritative counter-asset still sizes the tracked input from same-block
  // reserves, the inverse of the existing untracked-output imply.
  if (trackedReferencePrice == null) {
    const pricedOthers = trustedPriceByIndex.flatMap((price, index) =>
      index !== trackedTokenIndex && price != null ? [{ index, price }] : [],
    );
    if (pricedOthers.length !== 1) {
      return { model: null, reason: "incomplete-exact-capture" };
    }
    const other = pricedOthers[0]!;
    const implied = (state.balances[other.index]! * other.price) / state.balances[trackedTokenIndex]!;
    if (!Number.isFinite(implied) || implied <= 0) {
      return { model: null, reason: "incomplete-exact-capture" };
    }
    trackedReferencePrice = implied;
    trackedReferenceSource = "pool-implied";
  }

  const symbolByAddress = new Map(
    reference.candidate.tokenAddresses.map((address, index) => [address, reference.candidate.tokenSymbols[index]!]),
  );
  const referencePrices: number[] = [];
  const referencePriceSources: Array<"tracked-market" | "pool-implied"> = [];
  for (let index = 0; index < state.tokenAddresses.length; index++) {
    if (index === trackedTokenIndex) {
      referencePrices[index] = trackedReferencePrice;
      referencePriceSources[index] = trackedReferenceSource;
      continue;
    }
    const trustedPrice = trustedPriceByIndex[index];
    if (trustedPrice != null) {
      referencePrices[index] = trustedPrice;
      referencePriceSources[index] = "tracked-market";
      continue;
    }
    if (assetIds[index]) {
      return { model: null, reason: "incomplete-exact-capture" };
    }
    const trackedBalance = state.balances[trackedTokenIndex]!;
    const balance = state.balances[index]!;
    const poolImpliedPrice = (trackedBalance * trackedReferencePrice) / balance;
    if (!Number.isFinite(poolImpliedPrice) || poolImpliedPrice <= 0) {
      return { model: null, reason: "incomplete-exact-capture" };
    }
    referencePrices[index] = poolImpliedPrice;
    referencePriceSources[index] = "pool-implied";
  }

  return {
    model: {
      source: input.deployment.source,
      invariant: "constant-product",
      trackedTokenIndex,
      feeRate: input.feeRate,
      tokens: state.tokenAddresses.map((address, index) => {
        const assetKey = canonicalExitRouteAssetKey(input.deployment.chain, address);
        const trackedAssetId = assetIds[index];
        return {
          address,
          symbol: input.contractMetaByChainAddress.get(assetKey)?.symbol ?? symbolByAddress.get(address) ?? address,
          decimals: state.decimals[index]!,
          balance: state.balances[index]!,
          referencePriceUsd: referencePrices[index]!,
          referencePriceSource: referencePriceSources[index]!,
          ...(trackedAssetId ? { trackedAssetId } : {}),
        };
      }),
    },
    reason: "incomplete-exact-capture",
  };
}

async function enrichDeployment(input: {
  deployment: EvmV2Deployment;
  probes: PairProbe[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  stablecoinPriceById: Map<string, number>;
  dependencies: EvmV2ExecutionDependencies;
}): Promise<void> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 15_000,
    maxRetries: 0,
  };
  const blockNumber = await input.dependencies.fetchBlockNumber(input.deployment.chain, rpcOptions);
  if (blockNumber == null) {
    for (const probe of input.probes)
      for (const reference of probe.references) gateReference(reference, "incomplete-exact-capture");
    return;
  }
  const factoryCode = await input.dependencies.fetchCodeAtBlock(
    input.deployment.chain,
    input.deployment.factoryAddress,
    blockNumber,
    rpcOptions,
  );
  if (
    factoryCode == null ||
    input.dependencies.hashCode(factoryCode).toLowerCase() !== input.deployment.expectedFactoryCodeHash.toLowerCase()
  ) {
    for (const probe of input.probes)
      for (const reference of probe.references) gateReference(reference, "deployment-code-mismatch");
    return;
  }

  if (input.deployment.binding === "aerodrome-volatile") {
    const implementationCode = await input.dependencies.fetchCodeAtBlock(
      input.deployment.chain,
      input.deployment.expectedImplementationAddress,
      blockNumber,
      rpcOptions,
    );
    if (
      implementationCode == null ||
      input.dependencies.hashCode(implementationCode).toLowerCase() !==
        input.deployment.expectedImplementationCodeHash.toLowerCase()
    ) {
      for (const probe of input.probes)
        for (const reference of probe.references) gateReference(reference, "deployment-code-mismatch");
      return;
    }
  }

  if (input.deployment.binding === "aerodrome-volatile") {
    const deploymentCalls = [
      {
        label: "v2-factory-implementation",
        target: input.deployment.factoryAddress,
        callData: AERODROME_IMPLEMENTATION_SELECTOR,
      },
      {
        label: "v2-factory-paused",
        target: input.deployment.factoryAddress,
        callData: AERODROME_IS_PAUSED_SELECTOR,
      },
    ];
    const rawDeploymentResults = await input.dependencies.fetchMulticall(
      input.deployment.chain,
      deploymentCalls,
      blockNumber,
      rpcOptions,
    );
    if (!rawDeploymentResults) {
      for (const probe of input.probes)
        for (const reference of probe.references) gateReference(reference, "incomplete-exact-capture");
      return;
    }
    const deploymentResults = resultMap(rawDeploymentResults);
    const implementation = decodeAddressResult(deploymentResults.get("v2-factory-implementation"));
    if (implementation !== input.deployment.expectedImplementationAddress) {
      for (const probe of input.probes)
        for (const reference of probe.references) gateReference(reference, "deployment-code-mismatch");
      return;
    }
    const paused = decodeBoolResult(deploymentResults.get("v2-factory-paused"));
    if (paused == null || paused) {
      const reason: V2GateReason = paused ? "paused-or-swap-disabled" : "incomplete-exact-capture";
      for (const probe of input.probes) for (const reference of probe.references) gateReference(reference, reason);
      return;
    }
  }

  for (let startIndex = 0; startIndex < input.probes.length; startIndex += MAX_PROBES_PER_MULTICALL) {
    throwIfAborted(input.signal);
    const probes = input.probes.slice(startIndex, startIndex + MAX_PROBES_PER_MULTICALL);
    const poolCalls = probes.flatMap((probe, batchIndex) => {
      const index = startIndex + batchIndex;
      const prefix = `v2-${index}`;
      const [token0, token1] = probe.candidate.tokenAddresses;
      const pairCallData =
        input.deployment.binding === "aerodrome-volatile"
          ? `${AERODROME_GET_POOL_SELECTOR}${encodeAddress(token0)}${encodeAddress(token1)}${encodeUint256(0)}`
          : `${GET_PAIR_SELECTOR}${encodeAddress(token0)}${encodeAddress(token1)}`;
      return [
        {
          label: `${prefix}-pair`,
          target: input.deployment.factoryAddress,
          callData: pairCallData,
        },
        { label: `${prefix}-token0`, target: probe.candidate.poolAddress, callData: TOKEN_0_SELECTOR },
        { label: `${prefix}-token1`, target: probe.candidate.poolAddress, callData: TOKEN_1_SELECTOR },
        { label: `${prefix}-reserves`, target: probe.candidate.poolAddress, callData: GET_RESERVES_SELECTOR },
        { label: `${prefix}-decimals0`, target: token0, callData: DECIMALS_SELECTOR },
        { label: `${prefix}-decimals1`, target: token1, callData: DECIMALS_SELECTOR },
        ...(input.deployment.binding === "aerodrome-volatile"
          ? [
            {
              label: `${prefix}-fee`,
              target: input.deployment.factoryAddress,
              callData: `${AERODROME_GET_FEE_SELECTOR}${encodeAddress(probe.candidate.poolAddress)}${encodeUint256(0)}`,
            },
            { label: `${prefix}-stable`, target: probe.candidate.poolAddress, callData: AERODROME_STABLE_SELECTOR },
          ]
          : []),
      ];
    });
    const rawResults = await input.dependencies.fetchMulticall(
      input.deployment.chain,
      poolCalls,
      blockNumber,
      rpcOptions,
    );
    if (!rawResults) {
      for (const probe of probes)
        for (const reference of probe.references) gateReference(reference, "incomplete-exact-capture");
      continue;
    }
    const results = resultMap(rawResults);

    for (let batchIndex = 0; batchIndex < probes.length; batchIndex++) {
      const index = startIndex + batchIndex;
      const probe = probes[batchIndex]!;
      let feeRate: number;
      if (input.deployment.binding === "aerodrome-volatile") {
        const stable = decodeBoolResult(results.get(`v2-${index}-stable`));
        if (stable == null || stable) {
          const reason: V2GateReason = stable ? "unsupported-invariant" : "incomplete-exact-capture";
          for (const reference of probe.references) gateReference(reference, reason);
          continue;
        }
        const feeBps = decodeUint256Result(results.get(`v2-${index}-fee`));
        if (feeBps == null || feeBps > AERODROME_MAX_FEE_BPS) {
          for (const reference of probe.references) gateReference(reference, "incomplete-exact-capture");
          continue;
        }
        feeRate = Number(feeBps) / 10_000;
      } else {
        feeRate = input.deployment.feeRate;
      }
      const verified = parseVerifiedPairState(probe, index, results);
      if (!verified.state) {
        for (const reference of probe.references) gateReference(reference, verified.reason);
        continue;
      }
      for (const reference of probe.references) {
        reference.pool.poolId = canonicalExitRouteAssetKey(input.deployment.chain, probe.candidate.poolAddress);
        const built = buildExecutionModel({
          reference,
          deployment: input.deployment,
          feeRate,
          state: verified.state,
          chainAddressToId: input.chainAddressToId,
          contractMetaByChainAddress: input.contractMetaByChainAddress,
          stablecoinPriceById: input.stablecoinPriceById,
        });
        if (!built.model) {
          gateReference(reference, built.reason);
          continue;
        }
        const extra = { ...(reference.pool.extra ?? {}) };
        delete extra.executionCapabilityGate;
        delete extra.evmV2ExecutionCandidate;
        extra.ammExecutionModel = built.model;
        extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
        reference.pool.extra = extra;
      }
    }
  }
}

export async function enrichEvmV2ExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  dependencies?: EvmV2ExecutionDependencies;
}): Promise<void> {
  const references: CandidateReference[] = [];
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      const candidate = pool.extra?.evmV2ExecutionCandidate;
      if (candidate) references.push({ stablecoinId, pool, candidate });
    }
  }
  if (references.length === 0) return;
  if (!input.chainRpcs) {
    for (const reference of references) clearCandidate(reference);
    return;
  }

  const deployments = new Map(
    EVM_V2_EXECUTION_DEPLOYMENTS.map((deployment) => [deploymentKey(deployment.source, deployment.chain), deployment]),
  );
  const probesByDeployment = new Map<string, Map<string, PairProbe>>();
  for (const reference of references) {
    const key = deploymentKey(reference.candidate.source, reference.pool.chain);
    if (!deployments.has(key)) {
      gateReference(reference, "unsupported-chain");
      continue;
    }
    const probes = probesByDeployment.get(key) ?? new Map<string, PairProbe>();
    const keyForCandidate = candidateKey(reference.candidate);
    const probe = probes.get(keyForCandidate) ?? { candidate: reference.candidate, references: [] };
    probe.references.push(reference);
    probes.set(keyForCandidate, probe);
    probesByDeployment.set(key, probes);
  }

  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  for (const [key, probes] of probesByDeployment) {
    const deployment = deployments.get(key)!;
    try {
      await enrichDeployment({
        deployment,
        probes: [...probes.values()],
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        chainAddressToId: input.chainAddressToId,
        contractMetaByChainAddress: input.contractMetaByChainAddress,
        stablecoinPriceById: input.stablecoinPriceById,
        dependencies,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      for (const probe of probes.values()) {
        for (const reference of probe.references) gateReference(reference, "incomplete-exact-capture");
      }
    }
  }
}
