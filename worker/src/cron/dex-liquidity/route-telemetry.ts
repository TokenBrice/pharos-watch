import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import type { ExitRouteObservation } from "@shared/types/market";
import type { DexLiquidityCronMetadata } from "../../lib/schemas";
import type { LiquidityMetrics } from "./types";
import type { CronResult } from "../../lib/cron-logger";
import { UNISWAP_V4_DEPLOYMENT } from "@shared/lib/measured-execution-deployment-policies";
import { normalizeProtocol } from "./pool-helpers";

export type MeasuredTargetFunnel = NonNullable<DexLiquidityCronMetadata["measuredTargetFunnel"]>;
export type MeasuredTargetFunnelGroup = MeasuredTargetFunnel["groups"][number];
export type ExitRouteSelection = NonNullable<DexLiquidityCronMetadata["exitRouteSelection"]>;
export type ExitRouteContinuity = NonNullable<DexLiquidityCronMetadata["exitRouteContinuity"]>;
export type DexRecoveryStageResult = NonNullable<NonNullable<DexLiquidityCronMetadata["stageRecovery"]>["stageResult"]>;
export type TargetEnrichmentTelemetry = NonNullable<MeasuredTargetFunnel["enrichment"]>;

export interface DexRouteRemovalEvidence {
  omittedRouteIds: Set<string>;
  poolReasons: Map<string, string>;
}

const telemetryEncoder = new TextEncoder();

/** A bounded prefix with explicit omissions; no capped count is published as a population total. */
export function boundTelemetryEntries<T>(entries: readonly T[], maxEntries: number, maxBytes: number): T[] {
  const selected: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const entryBytes = telemetryEncoder.encode(JSON.stringify(entry)).byteLength + 1;
    if (selected.length === maxEntries || bytes + entryBytes > maxBytes) break;
    selected.push(entry);
    bytes += entryBytes;
  }
  return selected;
}

export function incrementReason(reasons: Record<string, number>, reason: string, count = 1): void {
  reasons[reason] = (reasons[reason] ?? 0) + count;
}

export function measuredPoolProfileIds(pool: LiquidityMetrics["topPools"][number]): string[] {
  const profiles = new Set([
    ...(pool.extra?.measuredExecutionTargets ?? []).map((target) => target.adapterProfileId),
    ...(pool.extra?.measuredExecutionTarget ? [pool.extra.measuredExecutionTarget.adapterProfileId] : []),
    ...(pool.extra?.measuredExecutionDiagnostic ? [pool.extra.measuredExecutionDiagnostic.adapterProfileId] : []),
  ]);
  if (profiles.size === 0) {
    const protocol = normalizeProtocol(pool.project);
    if (protocol === "uniswap-v4") profiles.add(UNISWAP_V4_DEPLOYMENT.adapterProfileId);
    else if (protocol === "uniswap-v3") profiles.add("uniswap-v3-quoter-v2");
    else if (protocol === "pancakeswap" && pool.poolType.startsWith("pancakeswap-v3")) profiles.add("pancakeswap-v3-quoter-v2");
    else if (protocol === "aerodrome" && pool.poolType.startsWith("aerodrome-slipstream")) profiles.add("aerodrome-slipstream-quoter-v2");
    else if (protocol === "hyperswap-v3") profiles.add("hyperswap-v3-quoter-v2");
    else if (protocol === "kodiak-v3") profiles.add("kodiak-v3-quoter-v2");
  }
  return [...profiles];
}

export function getMeasuredTargetFunnelGroup(
  groups: Map<string, MeasuredTargetFunnelGroup>, adapterProfileId: string, chain: string,
): MeasuredTargetFunnelGroup {
  const key = `${adapterProfileId}:${chain}`;
  let group = groups.get(key);
  if (!group) {
    group = { adapterProfileId, chain, candidates: 0, descriptorResolved: 0, enriched: 0, retained: 0, activeTargets: 0, dropReasons: {} };
    groups.set(key, group);
  }
  return group;
}

export function summarizeMeasuredTargetFunnel(groups: Map<string, MeasuredTargetFunnelGroup>): MeasuredTargetFunnel {
  const ranked = [...groups.values()].sort((a, b) => b.candidates - a.candidates || a.adapterProfileId.localeCompare(b.adapterProfileId) || a.chain.localeCompare(b.chain));
  const bounded = boundTelemetryEntries(ranked, 64, 12_288);
  return { stageOrigin: "scheduled", groups: bounded, groupsOmitted: ranked.length - bounded.length, sourceFailures: [], sourceFailuresOmitted: 0 };
}

/** Reapply the detail bound after enrichment counters have widened numeric values. */
export function boundMeasuredTargetFunnelGroups(funnel: MeasuredTargetFunnel): void {
  const bounded = boundTelemetryEntries(funnel.groups, 64, 12_288);
  funnel.groupsOmitted += funnel.groups.length - bounded.length;
  funnel.groups = bounded;
}

function physicalOutputKey(observation: ExitRouteObservation): string | null {
  if (observation.scope.kind !== "chain-contract" || !observation.output.assetKeys?.length) return null;
  return `${canonicalExitRouteScopedKey(observation.scope.chain, observation.scope.contractOrPoolId)}:${[...observation.output.assetKeys].sort().join(",")}`;
}

/** Reasons require exact route/pool evidence; coin-level aggregate gates are not causal proof. */
export function buildDexRouteTurnover(
  stablecoinId: string,
  previous: readonly ExitRouteObservation[],
  current: readonly ExitRouteObservation[],
  evidence?: DexRouteRemovalEvidence,
): ExitRouteSelection["topCoins"][number] {
  const previousIds = new Set(previous.map((route) => route.routeId));
  const currentIds = new Set(current.map((route) => route.routeId));
  const physicalOutputs = new Set(current.map(physicalOutputKey).filter((key): key is string => key !== null));
  const removalReasons: Record<string, number> = {};
  let routesRemoved = 0;
  for (const route of previous) {
    if (currentIds.has(route.routeId)) continue;
    routesRemoved++;
    const physicalOutput = physicalOutputKey(route);
    const poolKey = route.scope.kind === "chain-contract"
      ? canonicalExitRouteScopedKey(route.scope.chain, route.scope.contractOrPoolId) : null;
    const reason = evidence?.omittedRouteIds.has(route.routeId) ? "payload-overflow"
      : physicalOutput !== null && physicalOutputs.has(physicalOutput) ? "representative-change"
      : (poolKey === null ? undefined : evidence?.poolReasons.get(poolKey)) ?? "unknown";
    incrementReason(removalReasons, reason);
  }
  return { stablecoinId, routesAdded: current.filter((route) => !previousIds.has(route.routeId)).length, routesRemoved, removalReasons };
}

export function addDexRouteTurnover(summary: ExitRouteSelection, coin: ExitRouteSelection["topCoins"][number]): void {
  summary.comparedCoins++;
  summary.routesAdded += coin.routesAdded;
  summary.routesRemoved += coin.routesRemoved;
  if (coin.routesAdded + coin.routesRemoved === 0) return;
  summary.changedCoins++;
  for (const [reason, count] of Object.entries(coin.removalReasons)) incrementReason(summary.removalReasons, reason, count);
  summary.topCoins.push(coin);
  summary.topCoins.sort((a, b) => (b.routesAdded + b.routesRemoved) - (a.routesAdded + a.routesRemoved) || a.stablecoinId.localeCompare(b.stablecoinId));
  if (summary.topCoins.length > 25) summary.topCoins.pop();
  while (telemetryEncoder.encode(JSON.stringify(summary.topCoins)).byteLength > 8_192) summary.topCoins.pop();
  summary.topCoinsOmitted = summary.changedCoins - summary.topCoins.length;
}

/** Forward the recovered producer's diagnostic result, not its bulky persistence payload. */
export function projectDexRecoveryStageResult(result: CronResult): DexRecoveryStageResult {
  const raw = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  for (const key of ["generationId", "sourceSlotStartedAt", "syncStartSec", "registryEvaluation", "failedSources", "degradedSources", "uniV3CandidateCarryForward", "fallbackSignals", "targetEnrichment", "targetEnrichmentGroupsOmitted", "graphApiKeyConfigured", "d1Cost"]) {
    if (raw[key] !== undefined) metadata[key] = raw[key];
  }
  return { status: result.status ?? "ok", itemCount: result.itemCount, metadata };
}
