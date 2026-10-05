import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/market";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import { quoteSolidlyV2Raw, type SolidlyV2MathVariant, type SolidlyV2QuoteState } from "@shared/lib/solidly-v2-math";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem/utils";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmCodeAtBlock, fetchEvmMulticall3Aggregate3AtBlock } from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR } from "../../lib/evm-selectors";
import { usdToRawAmount } from "../measured-execution/fixed-point";
import {
  asEvmCaptureAddress, decodeEvmCaptureAddress, decodeEvmCaptureBool, decodeEvmCaptureUint256,
  mapEvmCaptureResults, resolveTrackedReferencePrices, runPinnedBlockCapture,
} from "./evm-capture-helpers";
import { normalizeProtocol } from "./pool-helpers";
import { resolveUniqueTrackedTokenIndex } from "./scoring-helpers";
import type { EvmV2ExecutionCandidate, LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";

export const SOLIDLY_V2_ABI = parseAbi([
  "function getPool(address,address,bool) view returns (address)",
  "function getPair(address,address,bool) view returns (address)",
  "function getFee(address,bool) view returns (uint256)",
  "function getAmountOut(uint256,address) view returns (uint256)",
  "function metadata() view returns (uint256,uint256,uint256,uint256,bool,address,address)",
]);

interface SolidlyV2Deployment {
  protocol: NonNullable<EvmV2ExecutionCandidate["solidlyProtocol"]>;
  chain: "base" | "optimism" | "sonic";
  variant: SolidlyV2MathVariant;
  factoryAddress: `0x${string}`;
  factoryCodeHash: `0x${string}`;
  poolCodeHash: `0x${string}`;
  implementationAddress?: `0x${string}`;
  implementationCodeHash?: `0x${string}`;
}

/** Reviewed pinned runtime packet: 2026-10-05. All cohorts collect diagnostic depth only. */
export const SOLIDLY_V2_DEPLOYMENTS: readonly SolidlyV2Deployment[] = [
  {
    protocol: "aerodrome", chain: "base", variant: "aerodrome",
    factoryAddress: "0x420dd381b31aef6683db6b902084cb0ffece40da",
    factoryCodeHash: "0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3",
    poolCodeHash: "0x7dd6ffe6daf4e82054c91becd71b8c9ba0a135f0f403da1ef7b0f81bb8ba4408",
    implementationAddress: "0xa4e46b4f701c62e14df11b48dce76a7d793cd6d7",
    implementationCodeHash: "0xd22754a0a3b39db7298dbbc2be1e34b34320988ea67065c85fa28ae66c02d31e",
  },
  {
    protocol: "velodrome", chain: "optimism", variant: "velodrome",
    factoryAddress: "0xf1046053aa5682b4f9a81b5481394da16be5ff5a",
    factoryCodeHash: "0x550399c9f73f73cc4bd8294c72155db44f7832fbc84fa190f38168869f90a8d4",
    poolCodeHash: "0x1338d20d2b1849933e083072be42c61c5ab7b8f4a5ce05d8f8944a4280f21b48",
    implementationAddress: "0x95885af5492195f0754be71ad1545fe81364e531",
    implementationCodeHash: "0x6a4a3ed659632c1f4920ffb47208c9bd8a6ff8acda6d51ca878642acb52c7d02",
  },
  {
    protocol: "shadow-exchange", chain: "sonic", variant: "shadow",
    factoryAddress: "0x2da25e7446a70d7be65fd4c053948becaa6374c8",
    factoryCodeHash: "0xe13d1508c4e3a955d3757f3e83e010cffc6e6512dd0eff7e723a2c19ef52d0c8",
    poolCodeHash: "0x195974f003706e271b23292ddc6c3cf931758e1833a17e6adb5d879519a167df",
  },
];

export function buildSolidlyV2ExecutionCandidate(input: {
  chain: string; protocol: string; poolType: string; poolAddress: string;
  tokenAddresses: readonly string[]; tokenSymbols?: readonly string[];
}): EvmV2ExecutionCandidate | null {
  const chain = canonicalExitRouteChain(input.chain);
  const protocol = normalizeProtocol(input.protocol);
  const deployment = SOLIDLY_V2_DEPLOYMENTS.find((row) => row.chain === chain &&
    (row.protocol === protocol || row.protocol === "shadow-exchange" && protocol === "shadow-exchange-legacy"));
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
          if (decodeEvmCaptureAddress(deployment.chain, mapped.get("implementation")) !== deployment.implementationAddress) return { ok: false, reason: "deployment-code-mismatch" };
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
              const fn = deployment.variant === "shadow" ? "getPair" : "getPool";
              return [
                { label: `${index}-stable`, target, callData: "0x22be3de1" },
                { label: `${index}-factory`, target, callData: "0xc45a0155" },
                { label: `${index}-token0`, target, callData: "0x0dfe1681" },
                { label: `${index}-token1`, target, callData: "0xd21220a7" },
                { label: `${index}-reserves`, target, callData: "0x0902f1ac" },
                { label: `${index}-metadata`, target, callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "metadata" }) },
                { label: `${index}-decimals0`, target: token0, callData: DECIMALS_SELECTOR },
                { label: `${index}-decimals1`, target: token1, callData: DECIMALS_SELECTOR },
                ...[false, true].flatMap((stable) => [
                  { label: `${index}-pair-${stable}`, target: deployment.factoryAddress, callData: encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: fn, args: [token0, token1, stable] }) },
                  { label: `${index}-fee-${stable}`, target: deployment.variant === "shadow" ? target : deployment.factoryAddress,
                    callData: deployment.variant === "shadow" ? "0xddca3f43" : encodeFunctionData({ abi: SOLIDLY_V2_ABI, functionName: "getFee", args: [target, stable] }) },
                ]),
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
              if (factory !== deployment.factoryAddress) { gate(rows, "exact-pool-join-unresolved"); continue; }
              if (stable == null) { gate(rows, "incomplete-exact-capture"); continue; }
              if (decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-pair-${stable}`)) !== candidate.poolAddress) { gate(rows, "exact-pool-join-unresolved"); continue; }
              const token0 = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-token0`));
              const token1 = decodeEvmCaptureAddress(deployment.chain, results.get(`${index}-token1`));
              if (!token0 || !token1 || token0 === token1 || !candidate.tokenAddresses.includes(token0) || !candidate.tokenAddresses.includes(token1)) { gate(rows, "ambiguous-token-identity"); continue; }
              const decimalReads = candidate.tokenAddresses.map((_, i) => decodeEvmCaptureUint256(results.get(`${index}-decimals${i}`)));
              const decimals = [decimalReads[candidate.tokenAddresses.indexOf(token0)], decimalReads[candidate.tokenAddresses.indexOf(token1)]];
              const fee = decodeEvmCaptureUint256(results.get(`${index}-fee-${stable}`));
              const denominator = deployment.variant === "shadow" ? 1_000_000 : 10_000;
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
                const tokenInIndex = tracked.trackedTokenIndex as 0 | 1;
                const points = EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.map((usd) => {
                  const amountIn = usdToRawAmount(usd, Number(decimals[tokenInIndex]), prices.value.prices[tokenInIndex]!);
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
                  source: "solidly-v2", invariant: stable ? "solidly-stable" : "constant-product",
                  trackedTokenIndex: tokenInIndex, feeRate: Number(fee) / denominator,
                  tokens: tokens.map((address, i) => ({
                    address, symbol: input.contractMetaByChainAddress.get(canonicalExitRouteAssetKey(deployment.chain, address))?.symbol ?? candidate.tokenSymbols[candidate.tokenAddresses.indexOf(address)]!,
                    decimals: Number(decimals[i]), balance: balances[i]!, referencePriceUsd: prices.value.prices[i]!, referencePriceSource: "tracked-market", trackedAssetId: assetIds[i],
                  })),
                  solidlyState: { variant: deployment.variant, stable, reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), fee: Number(fee), blockNumber, blockHash: header.hash, factoryAddress: deployment.factoryAddress, poolAddress: candidate.poolAddress,
                    verifiedQuoteCount: points.length, quoteChecks: points.map((point) => ({ tokenInIndex, amountIn: point.amountIn!.toString(), amountOut: point.amountOut!.toString() })),
                  },
                };
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
