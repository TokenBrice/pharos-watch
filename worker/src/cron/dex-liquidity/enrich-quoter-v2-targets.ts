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
import type { SourcePoolGraph, PoolEntry, SymbolLookups } from "./types";
import { incrementReason, type TargetEnrichmentTelemetry } from "./route-telemetry";

/** Bounded, hourly-rotating identity probes; selection is never execution evidence. */
export function selectQuoterV2EnrichmentCandidates(
  candidates: ReadonlyMap<string, readonly `0x${string}`[]>,
  capturedAt: number,
): Map<string, `0x${string}`[]> {
  const groups = [...candidates.entries()]
    .filter(([, addresses]) => addresses.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const selected = new Map<string, `0x${string}`[]>();
  if (groups.length === 0) return selected;
  const cycle = Math.floor(capturedAt / 3600);
  const groupOffset = cycle % groups.length;
  const stride = Math.max(1, Math.floor(QUOTER_V2_CAPTURE_MAX_POOLS / groups.length));
  const ordered = groups.map(([key, addresses]) => ({
    key, addresses: [...addresses].sort(), offset: (cycle * stride) % addresses.length, used: 0,
  }));
  let remaining = QUOTER_V2_CAPTURE_MAX_POOLS;
  while (remaining > 0) {
    let added = false;
    for (let index = 0; index < ordered.length && remaining > 0; index++) {
      const group = ordered[(index + groupOffset) % ordered.length];
      if (group.used === group.addresses.length) continue;
      const addresses = selected.get(group.key) ?? [];
      addresses.push(group.addresses[(group.offset + group.used) % group.addresses.length]);
      selected.set(group.key, addresses);
      group.used++;
      remaining--;
      added = true;
    }
    if (!added) break;
  }
  return selected;
}

/** Address-bound recovery only; fingerprints continue through the unique-source candidate resolver. */
export async function enrichQuoterV2ExecutionTargets(input: {
  metrics: Map<string, SourcePoolGraph>;
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
    for (const pool of metric.pools) {
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
  const selectedByGroup = selectQuoterV2EnrichmentCandidates(
    new Map([...groups].map(([key, group]) => [key, [...group.pools.keys()]])),
    input.capturedAt,
  );
  const nowMs = Date.now();
  const deadline = nowMs + (input.deadline?.childCeilingMs(QUOTER_V2_CAPTURE_MAX_WALL_MS, nowMs) ?? QUOTER_V2_CAPTURE_MAX_WALL_MS);
  const rpcBudget = createDexMeasuredExecutionRpcBudget({ maxRequests: QUOTER_V2_CAPTURE_MAX_REQUESTS, deadlineMs: deadline });
  for (const [key, selected] of selectedByGroup) {
    throwIfAborted(input.signal);
    const group = groups.get(key)!;
    const groupTelemetry = telemetry.find((entry) => entry.adapterProfileId === group.adapterProfileId && entry.chain === group.chain)!;
    if (rpcBudget.remainingRequests === 0 || rpcBudget.stopReason || Date.now() >= deadline) break;
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
  for (const [key, group] of groups) {
    const entry = telemetry.find((row) => row.adapterProfileId === group.adapterProfileId && row.chain === group.chain)!;
    const admitted = new Set(selectedByGroup.get(key) ?? []);
    for (const [address, references] of group.pools) {
      const deferred = references.filter((reference) => !attempted.has(reference.pool)).length;
      if (deferred > 0) incrementReason(entry.dropReasons,
        !admitted.has(address) ? "enrichment-cap" : Date.now() >= deadline ? "deadline-exhausted" : "request-budget-exhausted", deferred);
    }
  }
  return { exactPoolCount, exactCapableAssets: [...assets].sort(), telemetry };
}
