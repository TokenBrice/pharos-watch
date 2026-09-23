import { canonicalEvmAddress } from "@shared/lib/evm-address";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/lib/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { decodeAbiParameters, keccak256 } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { getScheduledSlotControlledDeadlineMs } from "../../lib/cron-timeouts";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR, encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import {
  asEvmCaptureAddress,
  decodeEvmCaptureAddress,
  decodeEvmCaptureBool,
  decodeEvmCaptureUint256,
  mapEvmCaptureResults,
  resolveTrackedReferencePrices,
  runPinnedBlockCapture,
} from "./evm-capture-helpers";
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
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  fetchCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
  hashCode: (code: `0x${string}`) => `0x${string}`;
}

const DEFAULT_DEPENDENCIES: EvmV2ExecutionDependencies = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockHeader: fetchEvmBlockHeader,
  fetchCodeAtBlock: fetchEvmCodeAtBlock,
  fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock,
  hashCode: keccak256,
};


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
  const poolAddress = asEvmCaptureAddress(chain, input.poolAddress);
  const token0 = asEvmCaptureAddress(chain, input.tokenAddresses[0]);
  const token1 = asEvmCaptureAddress(chain, input.tokenAddresses[1]);
  if (!poolAddress || !token0 || !token1 || token0 === token1) return null;

  const symbols = input.tokenSymbols?.length === 2 ? input.tokenSymbols.map((symbol) => symbol.trim()) : [];
  return {
    source,
    poolAddress,
    tokenAddresses: [token0, token1],
    tokenSymbols: [symbols[0] || token0, symbols[1] || token1],
  };
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

function decodeAddressResult(result: EvmMulticall3Result | undefined): `0x${string}` | null {
  return canonicalEvmAddress(decodeEvmCaptureAddress("ethereum", result), { allowZero: false });
}

function decodeDecimalsResult(result: EvmMulticall3Result | undefined): number | null {
  const value = decodeEvmCaptureUint256(result);
  return value != null && value <= 255n ? Number(value) : null;
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


function parseVerifiedPairState(
  probe: PairProbe,
  index: number,
  results: Map<string, EvmMulticall3Result>,
): { ok: true; state: VerifiedPairState } | { ok: false; reason: V2GateReason } {
  const prefix = `v2-${index}`;
  const resolvedPair = decodeAddressResult(results.get(`${prefix}-pair`));
  if (resolvedPair !== probe.candidate.poolAddress) {
    return { ok: false, reason: "exact-pool-join-unresolved" };
  }
  const token0 = decodeAddressResult(results.get(`${prefix}-token0`));
  const token1 = decodeAddressResult(results.get(`${prefix}-token1`));
  if (!token0 || !token1 || token0 === token1) {
    return { ok: false, reason: "ambiguous-token-identity" };
  }
  const expectedTokens = new Set(probe.candidate.tokenAddresses);
  if (!expectedTokens.has(token0) || !expectedTokens.has(token1)) {
    return { ok: false, reason: "ambiguous-token-identity" };
  }
  const decimals0 = decodeDecimalsResult(results.get(`${prefix}-decimals0`));
  const decimals1 = decodeDecimalsResult(results.get(`${prefix}-decimals1`));
  if (decimals0 == null || decimals1 == null) {
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  const decimalsByAddress = new Map<string, number>([
    [probe.candidate.tokenAddresses[0]!.toLowerCase(), decimals0],
    [probe.candidate.tokenAddresses[1]!.toLowerCase(), decimals1],
  ]);
  const token0Decimals = decimalsByAddress.get(token0.toLowerCase());
  const token1Decimals = decimalsByAddress.get(token1.toLowerCase());
  if (token0Decimals == null || token1Decimals == null) {
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  const reserves = decodeReservesResult(results.get(`${prefix}-reserves`));
  if (!reserves) {
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  const balance0 = Number(reserves[0]) / 10 ** token0Decimals;
  const balance1 = Number(reserves[1]) / 10 ** token1Decimals;
  if (!Number.isFinite(balance0) || !Number.isFinite(balance1) || balance0 <= 0 || balance1 <= 0) {
    return { ok: false, reason: "incomplete-exact-capture" };
  }
  return {
    ok: true,
    state: {
      tokenAddresses: [token0, token1],
      decimals: [token0Decimals, token1Decimals],
      balances: [balance0, balance1],
    },
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
}): { ok: true; model: DexAmmExecutionModel } | { ok: false; reason: V2GateReason } {
  const { reference, state } = input;
  const assetIds = state.tokenAddresses.map((address) =>
    input.chainAddressToId.get(canonicalExitRouteAssetKey(input.deployment.chain, address)),
  );
  const trackedResolution = resolveUniqueTrackedTokenIndex(assetIds, reference.stablecoinId);
  if (trackedResolution.trackedTokenIndex === null) return { ok: false, reason: trackedResolution.reason };
  const { trackedTokenIndex } = trackedResolution;
  const resolvedPrices = resolveTrackedReferencePrices({
    balances: state.balances,
    assetIds,
    trackedTokenIndex,
    stablecoinPriceById: input.stablecoinPriceById,
    implyUntrackedPrices: true,
  });
  if (!resolvedPrices.ok) return { ok: false, reason: "incomplete-exact-capture" };

  const symbolByAddress = new Map(
    reference.candidate.tokenAddresses.map((address, index) => [address, reference.candidate.tokenSymbols[index]!]),
  );
  const { prices: referencePrices, sources: referencePriceSources } = resolvedPrices.value;
  return {
    ok: true,
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
  deadlineMs: number;
}): Promise<void> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 15_000,
    // One network-only retry per URL for transient 429/timeout blips. The
    // deadline bounds the whole loop's wall time: each URL attempt skips
    // itself once the remaining budget is spent, and the batch loop below
    // stops issuing requests past it.
    maxRetries: 1,
    deadlineMs: input.deadlineMs,
  };
  const gateAll = (reason: V2GateReason) => {
    for (const probe of input.probes)
      for (const reference of probe.references) gateReference(reference, reason);
  };
  await runPinnedBlockCapture<Array<() => void>, V2GateReason>({
    chain: input.deployment.chain,
    rpcOptions,
    fetchBlockNumber: input.dependencies.fetchBlockNumber,
    fetchBlockHeader: input.dependencies.fetchBlockHeader,
    verifyDeployment: async ({ blockNumber }) => {
      const factoryCode = await input.dependencies.fetchCodeAtBlock(
        input.deployment.chain,
        input.deployment.factoryAddress,
        blockNumber,
        rpcOptions,
      );
      if (
        factoryCode == null ||
        input.dependencies.hashCode(factoryCode).toLowerCase() !==
          input.deployment.expectedFactoryCodeHash.toLowerCase()
      ) {
        return { ok: false, reason: "deployment-code-mismatch" };
      }
      if (input.deployment.binding !== "aerodrome-volatile") return { ok: true };
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
        return { ok: false, reason: "deployment-code-mismatch" };
      }
      const rawResults = await input.dependencies.fetchMulticall(
        input.deployment.chain,
        [
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
        ],
        blockNumber,
        rpcOptions,
      );
      if (!rawResults) return { ok: false, reason: "transport-unavailable" };
      const results = mapEvmCaptureResults(rawResults);
      if (
        decodeAddressResult(results.get("v2-factory-implementation")) !==
        input.deployment.expectedImplementationAddress
      ) {
        return { ok: false, reason: "deployment-code-mismatch" };
      }
      const paused = decodeEvmCaptureBool(results.get("v2-factory-paused"));
      if (paused == null || paused) {
        return {
          ok: false,
          reason: paused ? "paused-or-swap-disabled" : "incomplete-exact-capture",
        };
      }
      return { ok: true };
    },
    buildCalls: async ({ blockNumber }) => {
      const actions: Array<() => void> = [];
      const gate = (references: readonly CandidateReference[], reason: V2GateReason) => {
        for (const reference of references) actions.push(() => gateReference(reference, reason));
      };
      for (let startIndex = 0; startIndex < input.probes.length; startIndex += MAX_PROBES_PER_MULTICALL) {
        throwIfAborted(input.signal);
        // Check the remaining wall budget before issuing (or retrying) another
        // request: once spent, gate the remaining probes as transport
        // failures instead of letting retries extend the loop.
        if (Date.now() >= input.deadlineMs) {
          for (let remaining = startIndex; remaining < input.probes.length; remaining += 1) {
            gate(input.probes[remaining]!.references, "transport-unavailable");
          }
          break;
        }
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
            { label: `${prefix}-pair`, target: input.deployment.factoryAddress, callData: pairCallData },
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
          // Request-level transport failure: nothing was observed for this
          // batch, which is a provider condition, not a pool refusal.
          for (const probe of probes) gate(probe.references, "transport-unavailable");
          continue;
        }
        const results = mapEvmCaptureResults(rawResults);
        for (let batchIndex = 0; batchIndex < probes.length; batchIndex++) {
          const index = startIndex + batchIndex;
          const probe = probes[batchIndex]!;
          let feeRate: number;
          if (input.deployment.binding === "aerodrome-volatile") {
            const stable = decodeEvmCaptureBool(results.get(`v2-${index}-stable`));
            if (stable == null || stable) {
              gate(probe.references, stable ? "unsupported-invariant" : "incomplete-exact-capture");
              continue;
            }
            const feeBps = decodeEvmCaptureUint256(results.get(`v2-${index}-fee`));
            if (feeBps == null || feeBps > AERODROME_MAX_FEE_BPS) {
              gate(probe.references, "incomplete-exact-capture");
              continue;
            }
            feeRate = Number(feeBps) / 10_000;
          } else {
            feeRate = input.deployment.feeRate;
          }
          const verified = parseVerifiedPairState(probe, index, results);
          if (!verified.ok) {
            gate(probe.references, verified.reason);
            continue;
          }
          for (const reference of probe.references) {
            const built = buildExecutionModel({
              reference,
              deployment: input.deployment,
              feeRate,
              state: verified.state,
              chainAddressToId: input.chainAddressToId,
              contractMetaByChainAddress: input.contractMetaByChainAddress,
              stablecoinPriceById: input.stablecoinPriceById,
            });
            if (!built.ok) {
              actions.push(() => gateReference(reference, built.reason));
              continue;
            }
            actions.push(() => {
              reference.pool.poolId = canonicalExitRouteAssetKey(
                input.deployment.chain,
                probe.candidate.poolAddress,
              );
              const extra = { ...(reference.pool.extra ?? {}) };
              delete extra.executionCapabilityGate;
              delete extra.evmV2ExecutionCandidate;
              extra.ammExecutionModel = built.model;
              extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
              reference.pool.extra = extra;
            });
          }
        }
      }
      return { ok: true, value: actions };
    },
    onResults: (actions) => {
      for (const apply of actions) apply();
    },
    onFailure: (reason) => {
      // A missing reason is the pinned block or header fetch failing: a
      // transport condition observed nothing. Explicit verifyDeployment
      // refusals (code mismatch, paused) remain semantic gates.
      gateAll(reason ?? "transport-unavailable");
    },
  });
}

/**
 * Wall-time bound for one run of the whole staged V2 verification loop,
 * retries included. Independent of the stage slot so a provider brownout
 * cannot crowd out the scoring pass that follows.
 */
export const V2_ENRICHMENT_MAX_WALL_MS = 5 * 60_000;

/** Enrichment deadline: the earlier of the stage slot's budget and the loop cap. */
export function resolveV2EnrichmentDeadlineMs(slotStartedAtSec?: number): number {
  const slotControlledDeadlineMs = slotStartedAtSec != null
    ? getScheduledSlotControlledDeadlineMs(slotStartedAtSec * 1_000)
    : Number.POSITIVE_INFINITY;
  return Math.min(slotControlledDeadlineMs, Date.now() + V2_ENRICHMENT_MAX_WALL_MS);
}

export async function enrichEvmV2ExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  dependencies?: EvmV2ExecutionDependencies;
  /** Source-stage slot start, bounding verification against the stage budget. */
  slotStartedAtSec?: number;
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
    for (const reference of references) gateReference(reference, "transport-unavailable");
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
  const deadlineMs = resolveV2EnrichmentDeadlineMs(input.slotStartedAtSec);
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
        deadlineMs,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      // A thrown transport error observed nothing: classify it with the
      // request-level transport failures, not the semantic refusals.
      for (const probe of probes.values()) {
        for (const reference of probe.references) gateReference(reference, "transport-unavailable");
      }
    }
  }
}
