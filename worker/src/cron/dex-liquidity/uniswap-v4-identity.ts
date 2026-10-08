import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toBytes } from "viem/utils";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmBlockHeader, fetchEvmBlockNumber, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmRpcBatch, fetchEvmStorageAtBlock, type EvmRpcOptions } from "../../lib/evm-rpc";
import { rethrowIfAborted } from "../../lib/abort";
import type { SlotDeadline } from "../../lib/cron-timeouts";
import { buildUniswapV4MeasuredExecutionTarget } from "../measured-execution/inventory";
import { computeUniswapV4PoolId, getUniswapV4Deployment, UNISWAP_V4_ADAPTER_PROFILE_ID, UNISWAP_V4_HOOK_FREE_ADDRESS, verifyUniswapV4Deployment, type UniswapV4Deployment } from "../measured-execution/uniswap-v4";
import { createDexMeasuredExecutionRpcBudget } from "../measured-execution/profiles";
import type { UniswapV4ExecutionCandidate } from "../measured-execution/candidate-types";
import { normalizeProtocol } from "./pool-helpers";
import type { LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";
import { incrementReason, type TargetEnrichmentTelemetry } from "./route-telemetry";

const INITIALIZE_ABI = parseAbi([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
]);
const INITIALIZE_TOPIC = keccak256(toBytes("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
const STATE_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const TOKEN_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const MAX_POOLS = 128;
const MAX_REQUESTS = 384;
const MAX_WALL_MS = 120_000;
const MAX_BLOCK_AGE_SEC = 30 * 60;

interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  feePips: number;
  tickSpacing: number;
  hookAddress: `0x${string}`;
}

interface PoolProbe {
  deployment: UniswapV4Deployment;
  poolId: `0x${string}`;
  references: { stablecoinId: string; pool: PoolEntry }[];
  tvlUsd: number;
}

/** The indexed id bounds the log query; no fee/tick/hook permutations are tried. */
export function resolveUniswapV4InitializePoolKey(input: {
  logs: unknown;
  poolId: `0x${string}`;
  poolManagerAddress: `0x${string}`;
  blockNumber: number;
}): PoolKey | null {
  if (!Array.isArray(input.logs) || input.logs.length !== 1) return null;
  const log = input.logs[0];
  if (!log || typeof log !== "object" || log.removed === true ||
    typeof log.address !== "string" || log.address.toLowerCase() !== input.poolManagerAddress ||
    typeof log.blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(log.blockNumber) ||
    BigInt(log.blockNumber) > BigInt(input.blockNumber) ||
    typeof log.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(log.blockHash) ||
    typeof log.data !== "string" || !/^0x[0-9a-f]{320}$/i.test(log.data) ||
    !Array.isArray(log.topics) || log.topics.length !== 4 ||
    log.topics.some((topic: unknown) => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/i.test(topic))) return null;
  try {
    const { args } = decodeEventLog({ abi: INITIALIZE_ABI, eventName: "Initialize", data: log.data, topics: log.topics, strict: true });
    const key: PoolKey = {
      currency0: args.currency0.toLowerCase() as `0x${string}`,
      currency1: args.currency1.toLowerCase() as `0x${string}`,
      feePips: args.fee,
      tickSpacing: args.tickSpacing,
      hookAddress: args.hooks.toLowerCase() as `0x${string}`,
    };
    if (args.id.toLowerCase() !== input.poolId || key.currency0 >= key.currency1 ||
      key.hookAddress !== UNISWAP_V4_HOOK_FREE_ADDRESS || key.feePips > 1_000_000 ||
      key.tickSpacing <= 0 || key.tickSpacing > 32_767 || args.sqrtPriceX96 <= 0n ||
      computeUniswapV4PoolId(key) !== input.poolId) return null;
    return key;
  } catch {
    return null;
  }
}

interface Dependencies {
  blockNumber: typeof fetchEvmBlockNumber;
  header: typeof fetchEvmBlockHeader;
  rpcBatch: typeof fetchEvmRpcBatch;
  storage: typeof fetchEvmStorageAtBlock;
  multicall: typeof fetchEvmMulticall3Aggregate3AtBlock;
  verify: typeof verifyUniswapV4Deployment;
}
const DEFAULT_DEPENDENCIES: Dependencies = {
  blockNumber: fetchEvmBlockNumber, header: fetchEvmBlockHeader,
  rpcBatch: fetchEvmRpcBatch, multicall: fetchEvmMulticall3Aggregate3AtBlock,
  storage: fetchEvmStorageAtBlock,
  verify: verifyUniswapV4Deployment,
};

export async function readUniswapV4ExecutionCandidate(input: {
  deployment: UniswapV4Deployment;
  poolId: `0x${string}`;
  retainedTvlUsd: number;
  blockNumber: number;
  rpcOptions: EvmRpcOptions;
  dependencies?: Pick<Dependencies, "rpcBatch" | "multicall" | "storage">;
}): Promise<UniswapV4ExecutionCandidate | null> {
  const deps = input.dependencies ?? DEFAULT_DEPENDENCIES;
  let response = await deps.rpcBatch(input.deployment.chain, [{
    method: "eth_getLogs", params: [{
      address: input.deployment.poolManagerAddress,
      topics: [INITIALIZE_TOPIC, input.poolId],
      fromBlock: "0x0", toBlock: `0x${input.blockNumber.toString(16)}`,
    }],
  }], { ...input.rpcOptions, excludeSupplementalRpc: true });
  if (response == null) {
    // Some official RPCs (Tempo: 100,000 blocks) refuse an all-history range
    // even with the indexed PoolId filter. Find its initialization block from
    // the verified manager's monotone initialized state, not provider dates.
    // StateLibrary.POOLS_SLOT = 6; slot0's low 160 bits are sqrtPriceX96.
    // https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol
    const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [input.poolId, 6n]));
    const mask = (1n << 160n) - 1n;
    const historicalOptions = { ...input.rpcOptions, stateBlockHash: undefined };
    const initialState = await deps.storage(input.deployment.chain, input.deployment.poolManagerAddress, slot, 0, historicalOptions);
    const currentState = await deps.storage(input.deployment.chain, input.deployment.poolManagerAddress, slot, input.blockNumber, input.rpcOptions);
    if (!initialState || !currentState || BigInt(initialState) !== 0n || (BigInt(currentState) & mask) === 0n) return null;
    let low = 0;
    let high = input.blockNumber;
    for (let step = 0; high - low > 1 && step < 32; step++) {
      const mid = low + Math.floor((high - low) / 2);
      const state = await deps.storage(input.deployment.chain, input.deployment.poolManagerAddress, slot, mid, historicalOptions);
      if (!state) return null;
      if ((BigInt(state) & mask) === 0n) low = mid;
      else high = mid;
    }
    if (high - low !== 1) return null;
    const blockTag = `0x${high.toString(16)}`;
    response = await deps.rpcBatch(input.deployment.chain, [{
      method: "eth_getLogs", params: [{
        address: input.deployment.poolManagerAddress, topics: [INITIALIZE_TOPIC, input.poolId],
        fromBlock: blockTag, toBlock: blockTag,
      }],
    }], { ...input.rpcOptions, excludeSupplementalRpc: true });
  }
  const key = resolveUniswapV4InitializePoolKey({
    logs: response?.[0], poolId: input.poolId,
    poolManagerAddress: input.deployment.poolManagerAddress, blockNumber: input.blockNumber,
  });
  // Native-currency keys require an independently reviewed native-token metadata
  // source. Never reinterpret address(0) as an ERC20 or a wrapped currency.
  if (!key || key.currency0 === UNISWAP_V4_HOOK_FREE_ADDRESS) return null;
  const calls = [
    { label: "slot0", target: input.deployment.stateViewAddress, callData: encodeFunctionData({ abi: STATE_ABI, functionName: "getSlot0", args: [input.poolId] }), allowFailure: true },
    { label: "liquidity", target: input.deployment.stateViewAddress, callData: encodeFunctionData({ abi: STATE_ABI, functionName: "getLiquidity", args: [input.poolId] }), allowFailure: true },
    ...[key.currency0, key.currency1].flatMap((currency, index) => [
      { label: `decimals${index}`, target: currency, callData: encodeFunctionData({ abi: TOKEN_ABI, functionName: "decimals" }), allowFailure: true },
      { label: `symbol${index}`, target: currency, callData: encodeFunctionData({ abi: TOKEN_ABI, functionName: "symbol" }), allowFailure: true },
    ]),
  ];
  const results = await deps.multicall(input.deployment.chain, calls, input.blockNumber, input.rpcOptions);
  if (!results || results.length !== calls.length || results.some((row) => !row.success)) return null;
  const byLabel = new Map(results.map((row) => [row.label, row.returnData]));
  try {
    const [sqrtPriceX96, , , lpFee] = decodeFunctionResult({ abi: STATE_ABI, functionName: "getSlot0", data: byLabel.get("slot0")! });
    const liquidity = decodeFunctionResult({ abi: STATE_ABI, functionName: "getLiquidity", data: byLabel.get("liquidity")! });
    if (sqrtPriceX96 <= 0n || liquidity <= 0n || lpFee !== key.feePips) return null;
    const tokens = [key.currency0, key.currency1].map((address, index) => ({
      address,
      decimals: decodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", data: byLabel.get(`decimals${index}`)! }),
      symbol: decodeFunctionResult({ abi: TOKEN_ABI, functionName: "symbol", data: byLabel.get(`symbol${index}`)! }).trim(),
    }));
    if (tokens.some((token) => !token.symbol || token.symbol.length > 128)) return null;
    // Uniswap's token0Price is token0 per token1 (not its reciprocal).
    const token1Price = (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (tokens[0]!.decimals - tokens[1]!.decimals);
    if (!Number.isFinite(token1Price) || token1Price <= 0 || !Number.isFinite(1 / token1Price)) return null;
    return {
      chain: input.deployment.chain, poolId: input.poolId,
      feePips: key.feePips, tickSpacing: key.tickSpacing, hookAddress: key.hookAddress,
      activeLiquidity: liquidity.toString(), tvlUsd: input.retainedTvlUsd,
      token0Price: 1 / token1Price, token1Price,
      tokens: [tokens[0]!, tokens[1]!],
    };
  } catch {
    return null;
  }
}

/** Recover only retained physical identities, after primary + discovery merging.
 * Measurement values/source clocks stay with their original provider. Targets
 * still pass the ordinary quote-time deployment/state proof and maturity gates.
 */
export async function enrichUniswapV4ExecutionTargets(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  deadline?: SlotDeadline;
  dependencies?: Dependencies;
}): Promise<TargetEnrichmentTelemetry> {
  const probes = new Map<string, PoolProbe>();
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      if (normalizeProtocol(pool.project) !== "uniswap-v4" || pool.extra?.measuredExecutionTarget ||
        pool.extra?.measurement?.synthetic || pool.extra?.measurement?.decayed || !Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0) continue;
      const chain = canonicalExitRouteChain(pool.chain);
      const deployment = getUniswapV4Deployment(chain);
      if (!deployment) continue;
      const identity = pool.poolId.toLowerCase();
      const separator = identity.indexOf(":");
      if (separator >= 0 && (separator !== chain.length || !identity.startsWith(chain))) continue;
      const poolId = separator < 0 ? identity : identity.slice(separator + 1);
      if (!/^0x[0-9a-f]{64}$/.test(poolId)) continue;
      pool.extra ??= {};
      pool.extra.executionCapabilityGate = { family: "measured-execution", reason: "target-unresolved" };
      const key = canonicalExitRouteAssetKey(chain, poolId);
      const probe = probes.get(key) ?? { deployment, poolId: poolId as `0x${string}`, references: [], tvlUsd: pool.tvlUsd };
      probe.references.push({ stablecoinId, pool });
      probe.tvlUsd = Math.max(probe.tvlUsd, pool.tvlUsd);
      probes.set(key, probe);
    }
  }
  const telemetry: TargetEnrichmentTelemetry = [];
  const entryForChain = (chain: string) => {
    let entry = telemetry.find((row) => row.chain === chain);
    if (!entry) {
      entry = { adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID, chain, candidates: 0, attempted: 0, enriched: 0, dropReasons: {} };
      telemetry.push(entry);
    }
    return entry;
  };
  for (const probe of probes.values()) entryForChain(probe.deployment.chain).candidates += probe.references.length;
  if (!probes.size || !input.chainRpcs) {
    for (const entry of telemetry) incrementReason(entry.dropReasons, "rpc-unconfigured", entry.candidates);
    return telemetry;
  }
  const deps = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const nowMs = Date.now();
  const deadlineMs = nowMs + (input.deadline?.childCeilingMs(MAX_WALL_MS, nowMs) ?? MAX_WALL_MS);
  const budget = createDexMeasuredExecutionRpcBudget({ maxRequests: MAX_REQUESTS, deadlineMs });
  const rpcOptions: EvmRpcOptions = {
    chainRpcs: input.chainRpcs, signal: input.signal, timeoutMs: 8_000, deadlineMs, maxRetries: 0,
    beforeRequest: () => budget.tryConsume(),
  };
  const byChain = new Map<string, PoolProbe[]>();
  const selectedProbes = new Set<PoolProbe>();
  const attemptedProbes = new Set<PoolProbe>();
  for (const probe of [...probes.values()].sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, MAX_POOLS)) {
    selectedProbes.add(probe);
    const chainProbes = byChain.get(probe.deployment.chain) ?? [];
    chainProbes.push(probe);
    byChain.set(probe.deployment.chain, chainProbes);
  }
  for (const [chain, chainProbes] of byChain) {
    if (budget.stopReason) break;
    const mark = (detail: string) => {
      for (const probe of chainProbes) for (const reference of probe.references) {
        reference.pool.extra!.measuredExecutionDiagnostic = { adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID, detail };
        incrementReason(entryForChain(probe.deployment.chain).dropReasons, detail);
      }
    };
    for (const probe of chainProbes) {
      attemptedProbes.add(probe);
      entryForChain(chain).attempted += probe.references.length;
    }
    try {
      const blockNumber = await deps.blockNumber(chain, rpcOptions);
      const header = blockNumber == null ? null : await deps.header(chain, blockNumber, rpcOptions);
      const nowSec = Math.floor(Date.now() / 1_000);
      if (!header || header.timestamp > nowSec + 60 || nowSec - header.timestamp > MAX_BLOCK_AGE_SEC) { mark("identity-block-unavailable"); continue; }
      const verified = await deps.verify({ deployment: chainProbes[0]!.deployment, blockNumber: header.number, chainRpcs: input.chainRpcs, signal: input.signal, rpcBudget: budget });
      if (!verified.ok) { mark(verified.reason); continue; }
      const pending: { pool: PoolEntry; target: DexMeasuredExecutionTarget }[] = [];
      for (const probe of chainProbes) {
        if (budget.stopReason) break;
        const candidate = await readUniswapV4ExecutionCandidate({
          deployment: probe.deployment, poolId: probe.poolId, retainedTvlUsd: probe.tvlUsd,
          blockNumber: header.number, rpcOptions: { ...rpcOptions, stateBlockHash: header.hash }, dependencies: deps,
        });
        for (const { stablecoinId, pool } of probe.references) {
          const target = candidate && buildUniswapV4MeasuredExecutionTarget({
            candidate, stablecoinId, chainAddressToId: input.chainAddressToId,
            stablecoinPriceById: input.stablecoinPriceById,
            retainedTvlUsd: pool.tvlUsd, identityMatch: "exact-pool-id", capturedAt: header.timestamp,
          });
          if (target) pending.push({ pool, target });
          else {
            pool.extra!.measuredExecutionDiagnostic = { adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID, detail: "initialize-or-state-unresolved" };
            incrementReason(entryForChain(chain).dropReasons, "initialize-or-state-unresolved");
          }
        }
      }
      const finalHeader = await deps.header(chain, header.number, rpcOptions);
      if (!finalHeader || finalHeader.hash !== header.hash) { mark("identity-block-reorg-or-unavailable"); continue; }
      for (const { pool, target } of pending) {
        pool.extra!.measuredExecutionTarget = target;
        delete pool.extra!.executionCapabilityGate;
        delete pool.extra!.measuredExecutionDiagnostic;
        entryForChain(chain).enriched++;
      }
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      mark("identity-transport-unavailable");
    }
  }
  for (const probe of probes.values()) {
    if (!selectedProbes.has(probe)) incrementReason(entryForChain(probe.deployment.chain).dropReasons, "enrichment-cap", probe.references.length);
    else if (!attemptedProbes.has(probe)) incrementReason(entryForChain(probe.deployment.chain).dropReasons,
      budget.stopReason ?? "request-budget-exhausted", probe.references.length);
    else if (budget.stopReason) {
      const deferred = probe.references.filter(({ pool }) => !pool.extra?.measuredExecutionTarget && !pool.extra?.measuredExecutionDiagnostic).length;
      if (deferred > 0) incrementReason(entryForChain(probe.deployment.chain).dropReasons, budget.stopReason, deferred);
    }
  }
  return telemetry;
}
