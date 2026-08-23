import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import type { P4DexRouteObservationResult } from "@shared/lib/p4-exit-route-capacity";
import { MAX_DEX_EXIT_ROUTE_OBSERVATIONS, type ExitRouteObservation } from "@shared/types/market";
import { logWorkerEvent } from "../../lib/structured-log";
import type { LiquidityMetrics } from "./types";

function hasOperationallyInterruptedMeasuredEvidence(
  pool: LiquidityMetrics["topPools"][number],
): boolean {
  const profiles = [
    ...(pool.extra?.measuredExecution ? [pool.extra.measuredExecution] : []),
    ...(pool.extra?.measuredExecutions ?? []),
  ];
  return profiles.some((profile) => {
    const history = profile.observationHistory;
    return (
      history !== undefined &&
      history.consecutiveSuccessCount === 0 &&
      history.latestOperationalFailureAt !== null &&
      history.latestOperationalFailureAt === history.observationWindowEndedAt
    );
  });
}

function routeEvidenceRank(pool: LiquidityMetrics["topPools"][number]): number {
  const hasMeasuredEvidence =
    pool.extra?.measuredExecution !== undefined ||
    (pool.extra?.measuredExecutions?.length ?? 0) > 0;
  if (hasMeasuredEvidence && !hasOperationallyInterruptedMeasuredEvidence(pool)) return 0;
  if (pool.extra?.ammExecutionModel) return 1;
  if (hasMeasuredEvidence) return 2;
  if (pool.extra?.executionCapabilityGate) return 3;
  if (pool.poolType === "orderbook" && (pool.extra?.orderbookDepthUsd ?? 0) > 0) return 4;
  return 5;
}

interface DexRouteObservationPoolSelection {
  pools: LiquidityMetrics["topPools"];
}

/** Package-private scoring coordinator seam. */
export function selectDexRouteObservationPoolSet(
  currentPools: readonly LiquidityMetrics["topPools"][number][],
  retainedMeasuredPools: readonly LiquidityMetrics["topPools"][number][],
): DexRouteObservationPoolSelection {
  const byPhysicalPool = new Map<string, LiquidityMetrics["topPools"][number]>();
  for (const pool of [...currentPools, ...retainedMeasuredPools]) {
    const physicalPoolId =
      pool.extra?.measuredExecutionPhysicalPoolId ??
      pool.poolId;
    const key = canonicalExitRouteScopedKey(pool.chain, physicalPoolId);
    const previous = byPhysicalPool.get(key);
    if (
      previous === undefined ||
      routeEvidenceRank(pool) < routeEvidenceRank(previous) ||
      (routeEvidenceRank(pool) === routeEvidenceRank(previous) && pool.tvlUsd > previous.tvlUsd)
    ) {
      byPhysicalPool.set(key, pool);
    }
  }
  const ranked = [...byPhysicalPool.values()].sort(
    (left, right) =>
      routeEvidenceRank(left) - routeEvidenceRank(right) ||
      right.tvlUsd - left.tvlUsd ||
      left.poolId.localeCompare(right.poolId),
  );
  return {
    // Keep the private capability set independent from the bounded public
    // route payload. Observations are cheap summaries and are ranked at the
    // actual V9 stress request below, after executable capacity is known.
    pools: ranked,
  };
}

/** @internal Exported for focused route-observation selection tests. */
export function selectDexRouteObservationPools(
  currentPools: readonly LiquidityMetrics["topPools"][number][],
  retainedMeasuredPools: readonly LiquidityMetrics["topPools"][number][],
): LiquidityMetrics["topPools"] {
  return selectDexRouteObservationPoolSet(currentPools, retainedMeasuredPools).pools;
}

function routeObservationPhysicalPoolKey(observation: ExitRouteObservation): string {
  // P4 DEX observations carry the canonical physical-pool identity as a
  // common-mode key. Keep the first output candidate in the builder's stable
  // order so a multi-output pool cannot displace a later selected pool.
  const commonModePoolKey = observation.commonModeKeys.find((key) => key.startsWith("pool:"));
  if (commonModePoolKey) return commonModePoolKey;
  if (observation.scope.kind === "chain-contract") {
    return `pool:${canonicalExitRouteScopedKey(
      observation.scope.chain,
      observation.scope.contractOrPoolId,
    )}`;
  }
  return `route:${observation.routeId}`;
}

function scoreEligibleRoutePhysicalPoolKey(observation: ExitRouteObservation): string | null {
  return observation.scoreEligible ? routeObservationPhysicalPoolKey(observation) : null;
}

// Concentration bounds on the published payload, scaled with
// MAX_DEX_EXIT_ROUTE_OBSERVATIONS so widening the payload actually widens the
// evidence basis. Measured on the live surface at the previous 10/6/3/3 setting,
// all three anchor surfaces were saturated on THESE bounds rather than on the
// slot count (usdc-circle, usdt-tether and dai-makerdao each published exactly
// six Ethereum routes, three Curve routes and three Uniswap-V3 routes), so
// raising the slot count alone would have admitted almost nothing.
//
// The ratios are preserved (~58% one chain, ~29% one protocol/adapter) rather
// than the absolute counts: these bounds keep the payload representative, while
// genuine common-mode risk is modelled downstream by
// `resolveV9DistinctExitCapacity`, which groups routes on shared
// `physicalResourceKeys` and credits only the strongest member of each group.
const MAX_ROUTES_PER_CHAIN = 14;
const MAX_ROUTES_PER_PROTOCOL = 7;
const MAX_ROUTES_PER_ADAPTER = 7;

function executableCapacityAtV9Stress(observation: ExitRouteObservation): number {
  const point = observation.capacityCurve?.find(
    (candidate) =>
      candidate.requestedNotionalUsd === EXIT_ROUTE_SCORING_TABLES.request.capUsd &&
      candidate.maxCostBps === EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
  );
  return point?.executableUsd ?? 0;
}

function observationRank(left: ExitRouteObservation, right: ExitRouteObservation): number {
  return (
    Number(right.scoreEligible) - Number(left.scoreEligible) ||
    executableCapacityAtV9Stress(right) - executableCapacityAtV9Stress(left) ||
    Number(right.evidenceKind === "reserve-based-amm-simulation") -
      Number(left.evidenceKind === "reserve-based-amm-simulation") ||
    left.freshnessSeconds - right.freshnessSeconds ||
    left.routeId.localeCompare(right.routeId)
  );
}

function commonModeValue(observation: ExitRouteObservation, prefix: string): string | null {
  return observation.commonModeKeys.find((key) => key.startsWith(prefix)) ?? null;
}

function routesAreChainProtocolIndependent(
  left: ExitRouteObservation,
  right: ExitRouteObservation,
): boolean {
  const leftChain = commonModeValue(left, "chain:");
  const rightChain = commonModeValue(right, "chain:");
  const leftProtocol = commonModeValue(left, "protocol:");
  const rightProtocol = commonModeValue(right, "protocol:");
  return (
    (leftChain === null || rightChain === null || leftChain !== rightChain) &&
    (leftProtocol === null || rightProtocol === null || leftProtocol !== rightProtocol)
  );
}

interface DexRouteObservationPacking {
  observations: ExitRouteObservation[];
  bestIncludedCapacityUsd: number;
  bestOmittedCapacityUsd: number;
  omittedScoreEligibleObservationPoolCount: number;
  maxChainConcentration: number;
  maxProtocolConcentration: number;
}

export function selectDexRouteObservations(
  observations: readonly ExitRouteObservation[],
): DexRouteObservationPacking {
  const ranked = [...observations].sort(observationRank);
  const selected: ExitRouteObservation[] = [];
  const selectedIds = new Set<string>();
  const selectedPhysicalPools = new Set<string>();
  const chainCounts = new Map<string, number>();
  const protocolCounts = new Map<string, number>();
  const adapterCounts = new Map<string, number>();

  const add = (observation: ExitRouteObservation, guaranteed = false): boolean => {
    if (
      selected.length >= MAX_DEX_EXIT_ROUTE_OBSERVATIONS ||
      selectedIds.has(observation.routeId)
    ) {
      return false;
    }
    const chain = commonModeValue(observation, "chain:");
    const protocol = commonModeValue(observation, "protocol:");
    const adapter = observation.adapterProfileId ?? null;
    if (
      !guaranteed &&
      (
        (chain !== null && (chainCounts.get(chain) ?? 0) >= MAX_ROUTES_PER_CHAIN) ||
        (protocol !== null && (protocolCounts.get(protocol) ?? 0) >= MAX_ROUTES_PER_PROTOCOL) ||
        (adapter !== null && (adapterCounts.get(adapter) ?? 0) >= MAX_ROUTES_PER_ADAPTER)
      )
    ) {
      return false;
    }
    selected.push(observation);
    selectedIds.add(observation.routeId);
    selectedPhysicalPools.add(routeObservationPhysicalPoolKey(observation));
    if (chain !== null) chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
    if (protocol !== null) protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
    if (adapter !== null) adapterCounts.set(adapter, (adapterCounts.get(adapter) ?? 0) + 1);
    return true;
  };

  const bestCapacity = ranked.find((observation) => observation.scoreEligible);
  if (bestCapacity) add(bestCapacity, true);

  const bestExactFallback = ranked.find(
    (observation) =>
      observation.scoreEligible &&
      observation.evidenceKind === "reserve-based-amm-simulation",
  );
  if (bestExactFallback) add(bestExactFallback, true);

  if (bestCapacity) {
    const independent = ranked.find(
      (observation) =>
        observation.scoreEligible &&
        observation.routeId !== bestCapacity.routeId &&
        routesAreChainProtocolIndependent(bestCapacity, observation),
    );
    if (independent) add(independent, true);
  }

  // Prefer one output from each physical pool before spending payload slots on
  // additional outputs from a pool already represented.
  for (const observation of ranked) {
    if (selected.length >= MAX_DEX_EXIT_ROUTE_OBSERVATIONS) break;
    if (selectedPhysicalPools.has(routeObservationPhysicalPoolKey(observation))) continue;
    add(observation);
  }
  for (const observation of ranked) {
    if (selected.length >= MAX_DEX_EXIT_ROUTE_OBSERVATIONS) break;
    add(observation);
  }

  const selectedScoreEligiblePools = new Set(
    selected.map(scoreEligibleRoutePhysicalPoolKey).filter((key): key is string => key != null),
  );
  const allScoreEligiblePools = new Set(
    observations.map(scoreEligibleRoutePhysicalPoolKey).filter((key): key is string => key != null),
  );
  const omitted = ranked.filter((observation) => !selectedIds.has(observation.routeId));
  const concentration = (counts: Map<string, number>): number =>
    selected.length === 0 ? 0 : Math.max(0, ...counts.values()) / selected.length;

  return {
    observations: selected,
    bestIncludedCapacityUsd: Math.max(0, ...selected.map(executableCapacityAtV9Stress)),
    bestOmittedCapacityUsd: Math.max(0, ...omitted.map(executableCapacityAtV9Stress)),
    omittedScoreEligibleObservationPoolCount: [...allScoreEligiblePools].filter(
      (key) => !selectedScoreEligiblePools.has(key),
    ).length,
    maxChainConcentration: concentration(chainCounts),
    maxProtocolConcentration: concentration(protocolCounts),
  };
}

export interface DexRouteSelectionDiagnostic {
  stablecoinId: string;
  candidateObservationCount: number;
  publishedObservationCount: number;
  bestIncludedCapacityUsd: number;
  bestOmittedCapacityUsd: number;
  maxChainConcentration: number;
  maxProtocolConcentration: number;
}

export function applyDexRouteObservationBounds(
  stablecoinId: string,
  result: P4DexRouteObservationResult,
  diagnostics: DexRouteSelectionDiagnostic[],
): P4DexRouteObservationResult {
  const selection = selectDexRouteObservations(result.observations);
  const observations = selection.observations;
  const droppedObservationCount = Math.max(0, result.observations.length - observations.length);
  const noteworthyConcentration =
    observations.length >= 3 &&
    (
      selection.maxChainConcentration > 0.6 ||
      selection.maxProtocolConcentration > 0.6
    );
  if (
    diagnostics.length < 20 &&
    (droppedObservationCount > 0 || noteworthyConcentration)
  ) {
    diagnostics.push({
      stablecoinId,
      candidateObservationCount: result.observations.length,
      publishedObservationCount: observations.length,
      bestIncludedCapacityUsd: selection.bestIncludedCapacityUsd,
      bestOmittedCapacityUsd: selection.bestOmittedCapacityUsd,
      maxChainConcentration: selection.maxChainConcentration,
      maxProtocolConcentration: selection.maxProtocolConcentration,
    });
    if (noteworthyConcentration) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "dex_route_common_mode_concentration",
        job: "sync-dex-liquidity",
        message: "A bounded DEX route set is concentrated in one chain or protocol",
        metadata: {
          stablecoinId,
          observationCount: observations.length,
          maxChainConcentration: selection.maxChainConcentration,
          maxProtocolConcentration: selection.maxProtocolConcentration,
        },
      });
    }
  }
  if (droppedObservationCount === 0) return result;
  if (selection.bestOmittedCapacityUsd > selection.bestIncludedCapacityUsd) {
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "dex_route_capacity_dominance_violation",
      job: "sync-dex-liquidity",
      message: "A bounded DEX route payload omitted a higher-capacity candidate",
      metadata: {
        stablecoinId,
        bestIncludedCapacityUsd: selection.bestIncludedCapacityUsd,
        bestOmittedCapacityUsd: selection.bestOmittedCapacityUsd,
      },
    });
  }

  const emittedScoreEligiblePoolKeys = new Set(
    observations.map(scoreEligibleRoutePhysicalPoolKey).filter((key): key is string => key != null),
  );
  const evidenceCounts =
    droppedObservationCount === 0
      ? result.coverage.evidenceCounts
      : observations.reduce<Record<string, number>>((counts, observation) => {
          counts[observation.evidenceKind] = (counts[observation.evidenceKind] ?? 0) + 1;
          return counts;
        }, {});

  return {
    observations,
    coverage: {
      ...result.coverage,
      observationCount: observations.length,
      scoreEligibleObservationCount: observations.filter((observation) => observation.scoreEligible).length,
      scoreEligiblePoolCount: emittedScoreEligiblePoolKeys.size,
      unsupportedPoolCount:
        result.coverage.unsupportedPoolCount +
        selection.omittedScoreEligibleObservationPoolCount,
      evidenceCounts,
      unsupportedReasons: {
        ...result.coverage.unsupportedReasons,
        ...(selection.omittedScoreEligibleObservationPoolCount > 0
          ? {
              routeObservationPayloadOverflow:
                (result.coverage.unsupportedReasons.routeObservationPayloadOverflow ?? 0) +
                selection.omittedScoreEligibleObservationPoolCount,
            }
          : {}),
      },
    },
  };
}
