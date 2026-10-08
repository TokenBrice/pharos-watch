import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { canonicalExitRouteChain, canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { SlotDeadline } from "../../lib/cron-timeouts";
import { buildMeasuredPoolDirectionKey, buildPancakeMeasuredExecutionTargets, buildSlipstreamMeasuredExecutionTargets, buildUniV3DirectMeasuredExecutionTargets } from "../measured-execution/inventory";
import { getDexMeasuredExecutionDeployment, isDexMeasuredExecutionDeploymentScoreEligible, isTickSpacingQuoterV2Profile, type DexMeasuredExecutionDeployment } from "../measured-execution/registry";
import { createDexMeasuredExecutionRpcBudget } from "../measured-execution/profiles";
import { captureQuoterV2Pools, QUOTER_V2_CAPTURE_MAX_POOLS, QUOTER_V2_CAPTURE_MAX_REQUESTS, QUOTER_V2_CAPTURE_MAX_WALL_MS } from "./quoter-v2-pool-capture";
import { normalizeProtocol } from "./pool-helpers";
import type { LiquidityMetrics, PoolEntry, SymbolLookups } from "./types";
import { incrementReason, type TargetEnrichmentTelemetry } from "./route-telemetry";

/** Address-bound recovery only; fingerprints continue through the unique-source candidate resolver. */
export async function enrichQuoterV2ExecutionTargets(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  capturedAt: number;
  deadline?: SlotDeadline;
  pancakeMeasuredTargets: Map<string, DexMeasuredExecutionTarget>;
  slipstreamMeasuredTargets: Map<string, DexMeasuredExecutionTarget>;
}): Promise<{ exactPoolCount: number; exactCapableAssets: string[]; telemetry: TargetEnrichmentTelemetry }> {
  const groups = new Map<string, { chain: string; adapterProfileId: DexMeasuredExecutionDeployment["adapterProfileId"]; pools: Map<`0x${string}`, Array<{ stablecoinId: string; pool: PoolEntry }>> }>();
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      if (pool.extra?.measuredExecutionTarget || pool.extra?.ammExecutionModel || pool.extra?.measurement?.synthetic) continue;
      const protocol = normalizeProtocol(pool.project);
      const adapterProfileId = protocol === "uniswap-v3" ? "uniswap-v3-quoter-v2"
        : protocol === "pancakeswap" ? "pancakeswap-v3-quoter-v2"
        : protocol === "aerodrome" ? "aerodrome-slipstream-quoter-v2"
        : protocol === "hyperswap-v3" ? "hyperswap-v3-quoter-v2"
        : protocol === "kodiak-v3" ? "kodiak-v3-quoter-v2" : null;
      if (!adapterProfileId) continue;
      const chain = canonicalExitRouteChain(pool.chain);
      if (!getDexMeasuredExecutionDeployment(adapterProfileId, chain)) continue;
      // Never peel the final address off a fingerprint or other synthetic id.
      const address = canonicalEvmAddress(pool.poolId.startsWith(`${chain}:`) ? pool.poolId.slice(chain.length + 1) : pool.poolId);
      if (!address) continue;
      const key = `${adapterProfileId}:${chain}`;
      const group = groups.get(key) ?? { chain, adapterProfileId, pools: new Map() };
      const references = group.pools.get(address) ?? [];
      references.push({ stablecoinId, pool });
      group.pools.set(address, references);
      groups.set(key, group);
    }
  }
  const telemetry: TargetEnrichmentTelemetry = [...groups.values()].map((group) => ({
    adapterProfileId: group.adapterProfileId, chain: group.chain,
    candidates: [...group.pools.values()].reduce((sum, refs) => sum + refs.length, 0),
    attempted: 0, enriched: 0, dropReasons: {},
  }));
  const attempted = new Set<PoolEntry>();
  const assets = new Set<string>();
  let exactPoolCount = 0;
  let remaining = QUOTER_V2_CAPTURE_MAX_POOLS;
  const nowMs = Date.now();
  const deadline = nowMs + (input.deadline?.childCeilingMs(QUOTER_V2_CAPTURE_MAX_WALL_MS, nowMs) ?? QUOTER_V2_CAPTURE_MAX_WALL_MS);
  const rpcBudget = createDexMeasuredExecutionRpcBudget({ maxRequests: QUOTER_V2_CAPTURE_MAX_REQUESTS, deadlineMs: deadline });
  for (const group of groups.values()) {
    throwIfAborted(input.signal);
    const groupTelemetry = telemetry.find((entry) => entry.adapterProfileId === group.adapterProfileId && entry.chain === group.chain)!;
    if (remaining === 0 || rpcBudget.remainingRequests === 0 || rpcBudget.stopReason || Date.now() >= deadline) break;
    const selected = [...group.pools.keys()].slice(0, Math.min(remaining, QUOTER_V2_CAPTURE_MAX_POOLS));
    remaining -= selected.length;
    for (const address of selected) for (const reference of group.pools.get(address)!) {
      attempted.add(reference.pool);
      groupTelemetry.attempted++;
    }
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const result = await captureQuoterV2Pools({
      adapterProfileId: group.adapterProfileId, chain: group.chain,
      candidates: selected.map((poolAddress) => ({ poolAddress })),
      chainAddressToId: input.chainAddressToId, trackedStablecoinPrices: input.stablecoinPriceById,
      chainRpcs: input.chainRpcs, signal, rpcBudget,
    }).catch((error: unknown) => {
      // Our local deadline defers the remaining identities; caller cancellation must propagate.
      throwIfAborted(input.signal);
      if (!timeout.aborted) throw error;
      return null;
    });
    if (!result?.ok) {
      incrementReason(groupTelemetry.dropReasons, result === null ? "deadline-exhausted" : "source-failure",
        selected.reduce((sum, address) => sum + group.pools.get(address)!.length, 0));
      continue;
    }
    const builderInput = { pools: result.pools, chainAddressToId: input.chainAddressToId,
      symbolToChainScopedIds: new Map<string, Map<string, string[]>>(),
      stablecoinPriceById: input.stablecoinPriceById, capturedAt: input.capturedAt, adapterProfileId: group.adapterProfileId };
    const targets = group.adapterProfileId === "pancakeswap-v3-quoter-v2" ? buildPancakeMeasuredExecutionTargets(builderInput)
      : isTickSpacingQuoterV2Profile(group.adapterProfileId) ? buildSlipstreamMeasuredExecutionTargets(builderInput)
      : buildUniV3DirectMeasuredExecutionTargets(builderInput);
    for (const address of selected) {
      let attached = false;
      for (const reference of group.pools.get(address)!) {
        const physicalId = canonicalExitRouteAssetKey(group.chain, address);
        const target = targets.get(buildMeasuredPoolDirectionKey(reference.stablecoinId, physicalId));
        if (!target) {
          incrementReason(groupTelemetry.dropReasons, "descriptor-builder-unresolved");
          continue;
        }
        const retainedTarget = { ...target, retainedTvlUsd: reference.pool.tvlUsd };
        const extra = { ...(reference.pool.extra ?? {}) };
        // Factory membership has now proved the exact CL family; a preexisting
        // diagnostic V2 join refusal must not hide the current identity proof.
        delete extra.executionCapabilityGate;
        extra.measuredExecutionTarget = retainedTarget;
        extra.measuredExecutionPhysicalPoolId = physicalId;
        reference.pool.extra = extra;
        const accumulator = group.adapterProfileId === "pancakeswap-v3-quoter-v2" ? input.pancakeMeasuredTargets : input.slipstreamMeasuredTargets;
        accumulator.set(buildMeasuredPoolDirectionKey(reference.stablecoinId, physicalId), retainedTarget);
        if (isDexMeasuredExecutionDeploymentScoreEligible(group.adapterProfileId, group.chain)) assets.add(reference.stablecoinId);
        attached = true;
        groupTelemetry.enriched++;
      }
      if (attached) exactPoolCount++;
    }
  }
  for (const group of groups.values()) {
    const entry = telemetry.find((row) => row.adapterProfileId === group.adapterProfileId && row.chain === group.chain)!;
    const deferred = [...group.pools.values()].flat().filter((reference) => !attempted.has(reference.pool)).length;
    if (deferred > 0) incrementReason(entry.dropReasons,
      remaining === 0 ? "enrichment-cap" : Date.now() >= deadline ? "deadline-exhausted" : "request-budget-exhausted", deferred);
  }
  return { exactPoolCount, exactCapableAssets: [...assets].sort(), telemetry };
}
