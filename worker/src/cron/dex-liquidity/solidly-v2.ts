import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import { quoteSolidlyV2Raw, solidlyUsdToRawAmount, type SolidlyV2QuoteState } from "@shared/lib/solidly-v2-math";
import { SOLIDLY_V2_DEPLOYMENTS } from "@shared/lib/solidly-v2-deployments";
import { buildSolidlyV2CapacityChecks } from "@shared/lib/p4-exit-route-amm-simulation";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem/utils";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmCodeAtBlock, fetchEvmMulticall3Aggregate3AtBlock } from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR } from "../../lib/evm-selectors";
import {
  asEvmCaptureAddress, decodeEvmCaptureAddress, decodeEvmCaptureBool, decodeEvmCaptureUint256,
  mapEvmCaptureResults, resolveTrackedReferencePrices, runPinnedBlockCapture,
} from "./evm-capture-helpers";
import { normalizeProtocol } from "./pool-helpers";
import { resolveUniqueTrackedTokenIndex } from "./scoring-helpers";
import type { EvmV2ExecutionCandidate, LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";

export const SOLIDLY_V2_ABI = parseAbi([
  "function getPool(address,address,bool) view returns (address)",
  "function getFee(address,bool) view returns (uint256)",
  "function getAmountOut(uint256,address) view returns (uint256)",
  "function metadata() view returns (uint256,uint256,uint256,uint256,bool,address,address)",
]);


export function buildSolidlyV2ExecutionCandidate(input: {
  chain: string; protocol: string; poolType: string; poolAddress: string;
  tokenAddresses: readonly string[]; tokenSymbols?: readonly string[];
}): EvmV2ExecutionCandidate | null {
  const chain = canonicalExitRouteChain(input.chain);
  const protocol = normalizeProtocol(input.protocol);
  const deployment = SOLIDLY_V2_DEPLOYMENTS.find((row) => row.chain === chain && row.protocol === protocol);
  if (!deployment || /(v3|v4|concentrated|clmm|cg-cl-|slipstream)/i.test(input.poolType) || input.tokenAddresses.length !== 2) return null;
  const poolAddress = asEvmCaptureAddress(chain, input.poolAddress);
  const token0 = asEvmCaptureAddress(chain, input.tokenAddresses[0]);
  const token1 = asEvmCaptureAddress(chain, input.tokenAddresses[1]);
  if (!poolAddress || !token0 || !token1 || token0 === token1) return null;
  return {
    source: "solidly-v2", solidlyProtocol: deployment.protocol, poolAddress,
    tokenAddresses: [token0, token1],
    tokenSymbols: [input.tokenSymbols?.[0] || token0, input.tokenSymbols?.[1] || token1],
  };
}

type GateReason = DexExecutionCapabilityGate["reason"];
interface Reference { stablecoinId: string; pool: PoolEntry; candidate: EvmV2ExecutionCandidate }
interface SolidlyV2Dependencies {
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  fetchCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
  hashCode: (code: `0x${string}`) => `0x${string}`;
}
const DEFAULT_DEPENDENCIES: SolidlyV2Dependencies = {
  fetchBlockNumber: fetchEvmBlockNumber, fetchBlockHeader: fetchEvmBlockHeader,
  fetchCodeAtBlock: fetchEvmCodeAtBlock, fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock, hashCode: keccak256,
};

function applyGate(reference: Reference, reason: GateReason): void {
  const extra = { ...(reference.pool.extra ?? {}) };
  delete extra.ammExecutionModel;
  delete extra.evmV2ExecutionCandidate;
  extra.executionCapabilityGate = { family: "solidly-v2", reason };
  reference.pool.extra = extra;
}

export async function enrichSolidlyV2ExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  stablecoinPriceById: Map<string, number>;
  stablecoinPriceProvenanceById?: ReadonlyMap<string, Required<Pick<DexAmmExecutionModel["tokens"][number], "referencePriceSourceId" | "referencePriceObservedAt">>>;
  nowSec?: number;
  sourceGenerationId?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  dependencies?: SolidlyV2Dependencies;
  deadlineMs: number;
}): Promise<void> {
  const references: Reference[] = [];
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      const candidate = pool.extra?.evmV2ExecutionCandidate;
      if (candidate?.source === "solidly-v2") references.push({ stablecoinId, pool, candidate });
    }
  }
  if (references.length === 0) return;
  if (!input.chainRpcs) { for (const row of references) applyGate(row, "transport-unavailable"); return; }
  const { nowSec, sourceGenerationId } = input;
  if (nowSec == null || !Number.isSafeInteger(nowSec) || !sourceGenerationId) {
    for (const row of references) applyGate(row, "incomplete-exact-capture");
    return;
  }
  const deps = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const options = { chainRpcs: input.chainRpcs, signal: input.signal, timeoutMs: 15_000, maxRetries: 1, deadlineMs: input.deadlineMs };
  for (const deployment of SOLIDLY_V2_DEPLOYMENTS) {
    const cohort = references.filter((row) => canonicalExitRouteChain(row.pool.chain) === deployment.chain && row.candidate.solidlyProtocol === deployment.protocol);
    if (cohort.length === 0) continue;
    const probes = new Map<string, Reference[]>();
    for (const row of cohort) {
      const key = `${row.candidate.poolAddress}:${[...row.candidate.tokenAddresses].sort().join(":")}`;
      const group = probes.get(key) ?? [];
      group.push(row); probes.set(key, group);
    }
    const groups = [...probes.values()];
    try {
      await runPinnedBlockCapture<Array<() => void>, GateReason>({
        chain: deployment.chain, rpcOptions: options,
        nowSec, maxAgeSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
        fetchBlockNumber: deps.fetchBlockNumber, fetchBlockHeader: deps.fetchBlockHeader,
        verifyDeployment: async ({ blockNumber }) => {
          const factoryCode = await deps.fetchCodeAtBlock(deployment.chain, deployment.factoryAddress, blockNumber, options);
          if (!factoryCode) return { ok: false, reason: "transport-unavailable" };
          if (deps.hashCode(factoryCode) !== deployment.factoryCodeHash) return { ok: false, reason: "deployment-code-mismatch" };
          if (!deployment.implementationAddress) return { ok: true };
          const code = await deps.fetchCodeAtBlock(deployment.chain, deployment.implementationAddress, blockNumber, options);
          if (!code) return { ok: false, reason: "transport-unavailable" };
          if (deps.hashCode(code) !== deployment.implementationCodeHash) return { ok: false, reason: "deployment-code-mismatch" };
          const results = await deps.fetchMulticall(deployment.chain, [
            { label: "implementation", target: deployment.factoryAddress, callData: "0x5c60da1b" },
            { label: "paused", target: deployment.factoryAddress, callData: "0xb187bd26" },
          ], blockNumber, options);
          if (!results) return { ok: false, reason: "transport-unavailable" };
          const mapped = mapEvmCaptureResults(results);
          const implementation = decodeEvmCaptureAddress(deployment.chain, mapped.get("implementation"));
          if (!implementation) return { ok: false, reason: "incomplete-exact-capture" };
          if (implementation !== deployment.implementationAddress) return { ok: false, reason: "deployment-code-mismatch" };
          const paused = decodeEvmCaptureBool(mapped.get("paused"));
          return paused === false ? { ok: true } : { ok: false, reason: paused ? "paused-or-swap-disabled" : "incomplete-exact-capture" };
        },
        buildCalls: async ({ blockNumber, header }) => {
          const actions: Array<() => void> = [];
          const gate = (rows: Reference[], reason: GateReason) => { for (const row of rows) actions.push(() => applyGate(row, reason)); };
          for (let start = 0; start < groups.length; start += 4) {
            throwIfAborted(input.signal);
            if (Date.now() >= input.deadlineMs) { for (const rows of groups.slice(start)) gate(rows, "transport-unavailable"); break; }
            const batch = groups.slice(start, start + 4);
            const calls = batch.flatMap((rows, index) => {
              const candidate = rows[0]!.candidate;
              const target = candidate.poolAddress;
              const [token0, token1] = candidate.tokenAddresses;
              return [
                { label: `${index}-stable`, target, callData: "0x22be3de1" },
                { label: `${index}-factory`, target, callData: "0xc45a0155" },
                { label: `${index}-token0`, target, callData: "0x0dfe1681" },
                { label: `${index}-token1`, target, callData: "0xd21220a7" },
                { label: `${index}-reserves`, target, callData: "0x0902f1ac" },
                { label: `${index}-metadata`, target, callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "metadata" }) },
                { label: `${index}-decimals0`, target: token0, callData: DECIMALS_SELECTOR },
                { label: `${index}-decimals1`, target: token1, callData: DECIMALS_SELECTOR },
                { label: `${index}-pair-true`, target: deployment.factoryAddress, callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "getPool", args: [token0, token1, true] }) },
                { label: `${index}-fee-true`, target: deployment.factoryAddress, callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "getFee", args: [target, true] }) },
              ];
            });
            const raw = await deps.fetchMulticall(deployment.chain, calls, blockNumber, options);
            if (!raw) { for (const rows of batch) gate(rows, "transport-unavailable"); continue; }
            const results = mapEvmCaptureResults(raw);
            for (let index = 0; index < batch.length; index++) {
              const rows = batch[index]!;
              const candidate = rows[0]!.candidate;
              const stable = decodeEvmCaptureBool(results.get(`${index}-stable`));
              const factory = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-factory`));
              if (!factory || stable == null) { gate(rows, "incomplete-exact-capture"); continue; }
              if (factory !== deployment.factoryAddress) { gate(rows, "exact-pool-join-unresolved"); continue; }
              // Volatile diagnostics are retired. Keep the ordinary pool, but
              // never fetch runtime/quotes or fall through to generic CP authority.
              if (!stable) {
                for (const row of rows) actions.push(() => {
                  const extra = { ...(row.pool.extra ?? {}) };
                  delete extra.ammExecutionModel; delete extra.evmV2ExecutionCandidate; delete extra.executionCapabilityGate;
                  row.pool.extra = extra;
                });
                continue;
              }
              const member = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-pair-true`));
              if (!member) { gate(rows, "incomplete-exact-capture"); continue; }
              if (member !== candidate.poolAddress) { gate(rows, "exact-pool-join-unresolved"); continue; }
              const token0 = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-token0`));
              const token1 = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-token1`));
              if (!token0 || !token1 || token0 === token1 || !candidate.tokenAddresses.includes(token0) || !candidate.tokenAddresses.includes(token1)) { gate(rows, "ambiguous-token-identity"); continue; }
              const decimalReads = candidate.tokenAddresses.map((_, i) => decodeEvmCaptureUint256(results.get(`${index}-decimals${i}`)));
              const decimals = [decimalReads[candidate.tokenAddresses.indexOf(token0)], decimalReads[candidate.tokenAddresses.indexOf(token1)]];
              const fee = decodeEvmCaptureUint256(results.get(`${index}-fee-${stable}`));
              const denominator = 10_000;
              if (decimals.some((value) => value == null || value > 77n) || fee == null || fee >= BigInt(denominator)) { gate(rows, "incomplete-exact-capture"); continue; }
              const reserveResult = results.get(`${index}-reserves`);
              const metadataResult = results.get(`${index}-metadata`);
              if (!reserveResult?.success || !/^0x[0-9a-f]{192}$/i.test(reserveResult.returnData) || !metadataResult?.success) { gate(rows, "incomplete-exact-capture"); continue; }
              let reserves: readonly [bigint, bigint, bigint];
              try {
                reserves = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], reserveResult.returnData);
                const metadata = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "address" }, { type: "address" }], metadataResult.returnData);
                if (metadata[0] !== 10n ** decimals[0]! || metadata[1] !== 10n ** decimals[1]! || metadata[2] !== reserves[0] || metadata[3] !== reserves[1] || metadata[4] !== stable || metadata[5].toLowerCase() !== token0 || metadata[6].toLowerCase() !== token1) { gate(rows, "incomplete-exact-capture"); continue; }
              } catch { gate(rows, "incomplete-exact-capture"); continue; }
              if (reserves[0] <= 0n || reserves[1] <= 0n) { gate(rows, "invalid-invariant-parameters"); continue; }
              const poolCode = await deps.fetchCodeAtBlock(deployment.chain, candidate.poolAddress, blockNumber, options);
              if (!poolCode) { gate(rows, "transport-unavailable"); continue; }
              if (deps.hashCode(poolCode) !== deployment.poolCodeHash) { gate(rows, "deployment-code-mismatch"); continue; }
              const tokens = [token0, token1] as const;
              const assetIds = tokens.map((token) => input.chainAddressToId.get(canonicalExitRouteAssetKey(deployment.chain, token)));
              const balances = reserves.slice(0, 2).map((reserve, i) => Number(reserve) / 10 ** Number(decimals[i]));
              const quoteState: SolidlyV2QuoteState = { reserve0: reserves[0], reserve1: reserves[1], decimals0: Number(decimals[0]), decimals1: Number(decimals[1]), stable, fee, variant: deployment.variant };
              for (const reference of rows) {
                const tracked = resolveUniqueTrackedTokenIndex(assetIds, reference.stablecoinId);
                if (tracked.trackedTokenIndex == null) { gate([reference], tracked.reason); continue; }
                const prices = resolveTrackedReferencePrices({ balances, assetIds, trackedTokenIndex: tracked.trackedTokenIndex, stablecoinPriceById: input.stablecoinPriceById, implyUntrackedPrices: false });
                if (!prices.ok || prices.value.sources.some((source) => source !== "tracked-market")) { gate([reference], "incomplete-exact-capture"); continue; }
                const provenance = assetIds.map((assetId) => assetId ? input.stablecoinPriceProvenanceById?.get(assetId) : undefined);
                if (provenance.some((price) => !price?.referencePriceSourceId ||
                  !Number.isSafeInteger(price.referencePriceObservedAt) || price.referencePriceObservedAt <= 0 ||
                  price.referencePriceObservedAt > nowSec ||
                  price.referencePriceObservedAt > header.timestamp + 60 ||
                  nowSec - price.referencePriceObservedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC)) {
                  gate([reference], "incomplete-exact-capture"); continue;
                }
                const tokenInIndex = tracked.trackedTokenIndex as 0 | 1;
                const points = EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.map((usd) => {
                  const amountIn = solidlyUsdToRawAmount(usd, Number(decimals[tokenInIndex]), prices.value.prices[tokenInIndex]!);
                  const amountOut = amountIn == null ? null : quoteSolidlyV2Raw(quoteState, amountIn, tokenInIndex);
                  return { amountIn, amountOut };
                });
                if (points.some((point) => point.amountIn == null || point.amountOut == null)) { gate([reference], "invalid-invariant-parameters"); continue; }
                const quoteResults = await deps.fetchMulticall(deployment.chain, points.map((point, i) => ({
                  label: `quote-${i}`, target: candidate.poolAddress,
                  callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "getAmountOut", args: [point.amountIn!, tokens[tokenInIndex]] }),
                })), blockNumber, options);
                if (!quoteResults) { gate([reference], "transport-unavailable"); continue; }
                const quotes = mapEvmCaptureResults(quoteResults);
                if (points.some((point, i) => decodeEvmCaptureUint256(quotes.get(`quote-${i}`)) !== point.amountOut)) { gate([reference], "quote-failed"); continue; }
                const model: DexAmmExecutionModel = {
                  source: "solidly-v2", invariant: "solidly-stable",
                  trackedTokenIndex: tokenInIndex, feeRate: Number(fee) / denominator,
                  tokens: tokens.map((address, i) => ({
                    address, symbol: input.contractMetaByChainAddress.get(canonicalExitRouteAssetKey(deployment.chain, address))?.symbol ?? candidate.tokenSymbols[candidate.tokenAddresses.indexOf(address)]!,
                    decimals: Number(decimals[i]), balance: balances[i]!, referencePriceUsd: prices.value.prices[i]!, referencePriceSource: "tracked-market", trackedAssetId: assetIds[i],
                    ...provenance[i]!,
                  })),
                  solidlyState: { variant: deployment.variant, stable: true, reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), fee: Number(fee), blockNumber, blockHash: header.hash, blockTimestamp: header.timestamp, sourceGenerationId: input.sourceGenerationId!, factoryAddress: deployment.factoryAddress, poolAddress: candidate.poolAddress,
                    verifiedQuoteCount: points.length, quoteChecks: points.map((point) => ({ tokenInIndex, amountIn: point.amountIn!.toString(), amountOut: point.amountOut!.toString() })),
                  },
                };
                const capacityChecks = buildSolidlyV2CapacityChecks(model);
                if (!capacityChecks) { gate([reference], "invalid-invariant-parameters"); continue; }
                const endpointChecks = new Map(points.map((point) => [point.amountIn!.toString(), point.amountOut!.toString()]));
                const additional = new Map<string, string>();
                for (const check of capacityChecks) {
                  for (const [amountIn, amountOut] of [
                    [check.selectedAmountIn, check.selectedAmountOut],
                    [check.rejectedAmountIn, check.rejectedAmountOut],
                  ]) {
                    if (amountIn && amountIn !== "0" && amountOut != null && !endpointChecks.has(amountIn)) additional.set(amountIn, amountOut);
                  }
                }
                if (additional.size > 2 * points.length || Date.now() >= input.deadlineMs) { gate([reference], "transport-unavailable"); continue; }
                if (additional.size > 0) {
                  const endpoints = await deps.fetchMulticall(deployment.chain, [...additional].map(([amountIn], i) => ({
                    label: `endpoint-${i}`, target: candidate.poolAddress,
                    callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "getAmountOut", args: [BigInt(amountIn), tokens[tokenInIndex]] }),
                  })), blockNumber, options);
                  if (!endpoints || Date.now() >= input.deadlineMs) { gate([reference], "transport-unavailable"); continue; }
                  const endpointResults = mapEvmCaptureResults(endpoints);
                  if ([...additional].some(([, amountOut], i) => decodeEvmCaptureUint256(endpointResults.get(`endpoint-${i}`))?.toString() !== amountOut)) { gate([reference], "quote-failed"); continue; }
                  for (const [amountIn, amountOut] of additional) endpointChecks.set(amountIn, amountOut);
                }
                model.solidlyState!.capacityChecks = capacityChecks;
                model.solidlyState!.quoteChecks = [...endpointChecks].map(([amountIn, amountOut]) => ({ tokenInIndex, amountIn, amountOut }));
                model.solidlyState!.verifiedQuoteCount = endpointChecks.size;
                actions.push(() => {
                  reference.pool.poolId = canonicalExitRouteAssetKey(deployment.chain, candidate.poolAddress);
                  const extra = { ...(reference.pool.extra ?? {}) };
                  delete extra.evmV2ExecutionCandidate; delete extra.executionCapabilityGate;
                  extra.ammExecutionModel = model;
                  extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: true };
                  reference.pool.extra = extra;
                });
              }
            }
          }
          return { ok: true, value: actions };
        },
        onResults: (actions) => { for (const action of actions) action(); },
        onFailure: (reason) => { for (const reference of cohort) applyGate(reference, reason ?? "transport-unavailable"); },
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      for (const reference of cohort) applyGate(reference, "transport-unavailable");
    }
  }
  for (const reference of references) {
    if (reference.pool.extra?.evmV2ExecutionCandidate?.source === "solidly-v2") applyGate(reference, "unsupported-chain");
  }
}
