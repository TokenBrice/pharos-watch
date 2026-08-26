import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { roundTo } from "@shared/lib/math";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import {
  buildMeasuredLedgerCohortKey,
  type MeasuredLedgerAdmissionCohort,
} from "@shared/lib/measured-execution-ledger";
import type { ExitRouteObservation, ExitRouteObservationCoverage } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { LiquidityFallbackCounters, LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { buildMeasuredPoolDirectionKey } from "../measured-execution/inventory";
import { applyDexMeasuredExecutionGate, buildDexMeasuredExecutionRetainedRoutePools, joinDexMeasuredExecutionEvidence, loadDexMeasuredExecutionJoinEvidence, releaseDexMeasuredExecutionProofFields, stripDexMeasuredExecutionInternalFields, type DexMeasuredExecutionJoinDiagnostics } from "../measured-execution/join";
import { publishDexMeasuredTargetInventory, publishDexShadowMeasuredTargetInventory } from "../measured-execution/persistence";
import { isDexMeasuredExecutionTargetScoreEligible } from "../measured-execution/sync";
import { buildDexMeasuredTargetFingerprintIndex, resolveDexMeasuredTargetForRetainedPool } from "../measured-execution/retained-target-resolution";
import { computeDurabilityScore, computeLiquidityScore, initLiquidityFallbackCounters } from "./pool-helpers";
import { accumulateGlobalAggregate, applyProtocolCaps, applyRebuiltMetrics, classifyCoverage, filterRetainedPools, rebuildMetricsFromPools } from "./scoring-helpers";
import { applyDexRouteObservationBounds, selectDexRouteObservationPoolSet, selectDexRouteObservationPools, selectDexRouteObservations, type DexRouteSelectionDiagnostic } from "./dex-route-observation-selection";
import { DEX_LIQUIDITY_SCORING_BATCH_SIZE, DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN, computeDepthStability, computeSeriesStability, loadConfidentHistoryStability, loadCurrentDexScoringGenerationId, pruneExpiredDexPriceStages, type DexPriceStageRetentionResult } from "./dex-scoring-stage-store";
import { computeDexPrices, type DexPricePersistenceDiagnostics } from "./dex-price-publisher";

export {
  DEX_LIQUIDITY_SCORING_BATCH_SIZE, DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN,
  computeDepthStability, computeDexPrices,
  computeSeriesStability, loadConfidentHistoryStability,
  loadCurrentDexScoringGenerationId,
  pruneExpiredDexPriceStages,
  selectDexRouteObservationPools,
  selectDexRouteObservations,
};
export type { DexPricePersistenceDiagnostics };

function isP4OnlyPausedBalancerPool(pool: LiquidityMetrics["topPools"][number]): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "balancer-amm" && gate.reason === "paused-or-swap-disabled";
}

interface ProtocolCapDiagnostics {
  cappedPoolCount: number;
  cappedProtocols: number;
  reducedTvlUsd: number;
}

/**
 * Report-only shadow admission-opportunity capture from the daily 06:16
 * scoring run (Liquidity Score v6 Phases 0.1/0.4). Cohorts key on a stable
 * per-policy identity via `buildMeasuredLedgerCohortKey`; this run records
 * what it can decide (eligible/rejected/published) and the retrieval-time
 * join with the 08:10 quote record derives the full tri-state.
 */
export interface DexShadowAdmissionDiagnostics {
  /** Route-observation epoch of the emitting run (seconds). */
  cycle: number;
  targetGenerationId: string | null;
  cohorts: Record<string, MeasuredLedgerAdmissionCohort>;
}

interface ScoreDiagnostics {
  protocolCapReductions: ProtocolCapDiagnostics;
  /** Report-only optimistic-default/silent-exclusion counters from the scoring pass. */
  fallbackCounters: LiquidityFallbackCounters;
  routeSelection: DexRouteSelectionDiagnostic[];
  measuredExecution: {
    join: DexMeasuredExecutionJoinDiagnostics;
    inventoryTargetCount: number;
    shadowInventoryTargetCount: number;
    targetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
    shadowTargetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
    /** Populated only on the daily shadow-publication run; null otherwise. */
    shadowAdmission: DexShadowAdmissionDiagnostics | null;
  };
}

export type MeasuredTargetPublicationMode = "none" | "active" | "active-and-shadow";

type P4aFullScoreResult = FullScoreResult & {
  exitRouteObservations: ExitRouteObservation[];
  exitRouteObservationCoverage: ExitRouteObservationCoverage;
};

function weightedRatio(sum: number, total: number, places = 4): number | null {
  return total > 0 ? roundTo(sum / total, places) : null;
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
export async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  protocolTvlCaps: Map<string, number>,
  mcapById?: Map<string, number>,
  routeObservedAtSec = Math.floor(Date.now() / 1000),
  pancakeMeasuredTargets: Map<string, DexMeasuredExecutionTarget> = new Map(),
  signal?: AbortSignal,
  slipstreamMeasuredTargets: Map<string, DexMeasuredExecutionTarget> = new Map(),
  measuredTargetPublicationMode: MeasuredTargetPublicationMode = "active-and-shadow",
): Promise<{
  scores: Map<string, FullScoreResult>;
  globalAgg: GlobalAgg;
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  tvlStabilityMap: Map<string, number>;
  diagnostics: ScoreDiagnostics;
}> {
  let tvlStabilityMap = new Map<string, number>();
  let volumeStabilityMap = new Map<string, number>();
  try {
    ({ tvlStabilityMap, volumeStabilityMap } = await loadConfidentHistoryStability(db));
  } catch {
    /* non-blocking: history stability table may not exist yet (first run / pre-migration); fall back to neutral defaults */
  }

  const results = new Map<string, FullScoreResult>();
  const retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>();
  const routeSelectionDiagnostics: DexRouteSelectionDiagnostic[] = [];
  const routeObservedAt = Math.max(0, Math.floor(routeObservedAtSec));
  const slipstreamMeasuredTargetsByFingerprint =
    buildDexMeasuredTargetFingerprintIndex(slipstreamMeasuredTargets.values());

  // Global dedup accumulators — accumulated per-coin BEFORE top-10 truncation
  const seenPoolTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; vol7dMeasured: boolean; proto: string; chain: string }>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
  const protocolCapDiagnostics: ProtocolCapDiagnostics = { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };
  const fallbackCounters = initLiquidityFallbackCounters();
  const preparedRetainedPools = new Map<string, LiquidityMetrics["topPools"]>();
  const p4OnlyRetainedPools = new Map<string, LiquidityMetrics["topPools"]>();

  for (const [id, m] of [...metrics].filter(([stablecoinId]) => ACTIVE_IDS.has(stablecoinId))) {
    throwIfAborted(signal);
    p4OnlyRetainedPools.set(id, m.topPools.filter(isP4OnlyPausedBalancerPool));
    m.topPools = filterRetainedPools(m.topPools.filter((pool) => !isP4OnlyPausedBalancerPool(pool)), fallbackCounters);
    const capResult = applyProtocolCaps(m.topPools, protocolTvlCaps);
    protocolCapDiagnostics.cappedPoolCount += capResult.cappedPoolCount;
    protocolCapDiagnostics.cappedProtocols += capResult.cappedProtocols;
    protocolCapDiagnostics.reducedTvlUsd += capResult.reducedTvlUsd;

    const retainedPools = m.topPools;
    for (const pool of retainedPools) {
      const existingPacketTargets = pool.extra?.measuredExecutionTargets;
      if (existingPacketTargets) {
        pool.extra = { ...(pool.extra ?? {}) };
        if (
          existingPacketTargets.length !== 2 ||
          existingPacketTargets.some((target) => target.poolId !== existingPacketTargets[0]!.poolId)
        ) {
          delete pool.extra.measuredExecutionTargets;
          delete pool.extra.measuredExecutions;
          delete pool.extra.measuredExecutionProfiles;
          delete pool.extra.measuredExecutionDiagnostics;
        } else {
          pool.extra.measuredExecutionTargets = existingPacketTargets.map((target) => ({
            ...target,
            retainedTvlUsd: pool.tvlUsd,
            capturedAt: routeObservedAt,
          }));
          pool.extra.measuredExecutionPhysicalPoolId = existingPacketTargets[0]!.poolId;
          pool.extra.measuredExecutionDiagnostics = existingPacketTargets.map((target) => ({
            adapterProfileId: target.adapterProfileId,
            targetId: target.targetId,
          }));
        }
        continue;
      }
      const existingTarget = pool.extra?.measuredExecutionTarget;
      const isPancakeV3 =
        pool.project === "pancakeswap" && pool.poolType.startsWith("pancakeswap-v3");
      const isAerodromeSlipstream =
        (pool.project === "aerodrome" || pool.project === "aerodrome-slipstream") &&
        pool.poolType.startsWith("aerodrome-slipstream");
      const candidate =
        isPancakeV3
          ? pancakeMeasuredTargets.get(buildMeasuredPoolDirectionKey(id, pool.poolId))
          : isAerodromeSlipstream
            ? resolveDexMeasuredTargetForRetainedPool({
                stablecoinId: id,
                retainedPoolId: pool.poolId,
                retainedTvlUsd: pool.tvlUsd,
                adapterProfileId: "aerodrome-slipstream-quoter-v2",
                exactTargets: slipstreamMeasuredTargets,
                fingerprintTargets: slipstreamMeasuredTargetsByFingerprint,
              })
            : existingTarget;
      const adapterProfileId =
        isPancakeV3
          ? "pancakeswap-v3-quoter-v2"
          : isAerodromeSlipstream
            ? "aerodrome-slipstream-quoter-v2"
            : existingTarget?.adapterProfileId;
      if (!adapterProfileId) continue;

      pool.extra = { ...(pool.extra ?? {}) };
      if (
        !candidate ||
        candidate.adapterProfileId !== adapterProfileId ||
        candidate.poolTokenAddresses?.length !== 2
      ) {
        delete pool.extra.measuredExecutionTarget;
        delete pool.extra.measuredExecution;
        delete pool.extra.measuredExecutionProfile;
        delete pool.extra.measuredExecutionPhysicalPoolId;
        applyDexMeasuredExecutionGate(pool, "target-unresolved");
        pool.extra.measuredExecutionDiagnostic = { adapterProfileId };
        continue;
      }
      pool.extra.measuredExecutionTarget = {
        ...candidate,
        retainedTvlUsd: pool.tvlUsd,
        capturedAt: routeObservedAt,
      };
      pool.extra.measuredExecutionPhysicalPoolId = candidate.poolId;
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.measuredExecutionDiagnostic = {
        adapterProfileId: candidate.adapterProfileId,
        targetId: candidate.targetId,
      };
    }
    preparedRetainedPools.set(id, retainedPools);
  }

  // Target-only shadow families deliberately do not enter the retained pool
  // graph. Preserve those independently verified targets for the shadow
  // publication while active families still require a retained-pool join.
  const targetInventoryById = new Map(
    [...slipstreamMeasuredTargets.values()]
      .filter(
        (target) =>
          target.adapterProfileId === "uniswap-v3-quoter-v2" &&
          target.chain === "bsc" &&
          !isDexMeasuredExecutionTargetScoreEligible(target),
      )
      .map((target) => [target.targetId, target] as const),
  );
  for (const pools of preparedRetainedPools.values()) {
    for (const pool of pools) {
      for (const target of pool.extra?.measuredExecutionTargets ?? []) {
        targetInventoryById.set(target.targetId, target);
      }
      const target = pool.extra?.measuredExecutionTarget;
      if (target) targetInventoryById.set(target.targetId, target);
    }
  }
  // The adjusted target inventory and retained pools now own every downstream
  // descriptor. Release the producer maps before proof-heavy evidence is loaded.
  pancakeMeasuredTargets.clear();
  slipstreamMeasuredTargets.clear();
  slipstreamMeasuredTargetsByFingerprint.clear();

  const activeTargetInventory = [...targetInventoryById.values()].filter(isDexMeasuredExecutionTargetScoreEligible);
  const shadowTargetInventory = [...targetInventoryById.values()].filter(
    (target) => !isDexMeasuredExecutionTargetScoreEligible(target),
  );
  const inventoryTargetCount = activeTargetInventory.length;
  const shadowInventoryTargetCount = shadowTargetInventory.length;
  let targetPublication: ScoreDiagnostics["measuredExecution"]["targetPublication"];
  if (measuredTargetPublicationMode === "none") {
    targetPublication = { status: "skipped", reason: "publication-not-due" };
  } else if (inventoryTargetCount === 0) {
    targetPublication = { status: "skipped", reason: "no-score-eligible-targets" };
  } else {
    try {
      const publication = await publishDexMeasuredTargetInventory({
        db,
        targets: activeTargetInventory,
        capturedAt: routeObservedAt,
        signal,
      });
      targetPublication = { status: "published", ...publication };
    } catch (error) {
      rethrowIfAborted(error, signal);
      targetPublication = { status: "failed", reason: String(error).slice(0, 500) };
    } finally {
      targetInventoryById.clear();
    }
  }
  let shadowTargetPublication: ScoreDiagnostics["measuredExecution"]["shadowTargetPublication"];
  if (measuredTargetPublicationMode !== "active-and-shadow") {
    shadowTargetPublication = { status: "skipped", reason: "daily-shadow-publication-not-due" };
  } else if (shadowInventoryTargetCount === 0) {
    shadowTargetPublication = { status: "skipped", reason: "no-shadow-targets" };
  } else {
    try {
      const publication = await publishDexShadowMeasuredTargetInventory({
        db,
        targets: shadowTargetInventory,
        capturedAt: routeObservedAt,
        signal,
      });
      shadowTargetPublication = { status: "published", ...publication };
    } catch (error) {
      rethrowIfAborted(error, signal);
      shadowTargetPublication = { status: "failed", reason: String(error).slice(0, 500) };
    }
  }
  targetInventoryById.clear();

  // Shadow admission-opportunity capture (Phases 0.1/0.4). This is the only
  // place pre-target rejections are visible: a retained pool that failed target
  // admission carries its `executionCapabilityGate`, while every produced
  // shadow target sits in `shadowTargetInventory`. Emitted per policy cohort —
  // never aggregated by adapter+chain — so a healthy policy cannot mask a
  // broken sibling sharing the same adapter profile.
  let shadowAdmission: DexShadowAdmissionDiagnostics | null = null;
  if (measuredTargetPublicationMode === "active-and-shadow") {
    const cohorts: Record<string, MeasuredLedgerAdmissionCohort> = {};
    const cohortFor = (key: string) =>
      (cohorts[key] ??= { eligible: 0, rejected: 0, published: 0, gateReason: null });
    const shadowPublished = shadowTargetPublication.status === "published";
    const shadowPublicationFailed = shadowTargetPublication.status === "failed";
    for (const target of shadowTargetInventory) {
      const cohort = cohortFor(buildMeasuredLedgerCohortKey(target));
      cohort.eligible += 1;
      if (shadowPublished) cohort.published += 1;
      else if (shadowPublicationFailed && cohort.gateReason == null) {
        cohort.gateReason = "shadow-target-publication-failed";
      }
    }
    for (const [id, pools] of preparedRetainedPools) {
      for (const pool of pools) {
        const gate = pool.extra?.executionCapabilityGate;
        if (!gate) continue;
        const cohort = cohortFor(
          buildMeasuredLedgerCohortKey({ chain: pool.chain, poolId: pool.poolId, stablecoinId: id }),
        );
        cohort.eligible += 1;
        cohort.rejected += 1;
        if (cohort.gateReason == null) cohort.gateReason = `${gate.family}:${gate.reason}`;
      }
    }
    shadowAdmission = {
      cycle: routeObservedAt,
      targetGenerationId: shadowTargetPublication.status === "published"
        ? shadowTargetPublication.generationId
        : null,
      cohorts,
    };
  }

  const joinEvidence = await loadDexMeasuredExecutionJoinEvidence(db, signal);
  const measuredExecutionJoin = joinDexMeasuredExecutionEvidence({
    poolsByStablecoin: preparedRetainedPools,
    evidence: joinEvidence,
    nowSec: routeObservedAt,
  });
  const retainedMeasuredRoutePools = buildDexMeasuredExecutionRetainedRoutePools({
    poolsByStablecoin: preparedRetainedPools,
    evidence: joinEvidence,
    nowSec: routeObservedAt,
  });
  for (const pools of preparedRetainedPools.values()) {
    releaseDexMeasuredExecutionProofFields(pools);
  }
  for (const pools of retainedMeasuredRoutePools.values()) {
    releaseDexMeasuredExecutionProofFields(pools);
  }
  joinEvidence?.byTargetId.clear();

  for (const [id, m] of [...metrics].filter(([stablecoinId]) => ACTIVE_IDS.has(stablecoinId))) {
    throwIfAborted(signal);
    const retainedPools = preparedRetainedPools.get(id) ?? [];
    const rebuilt = rebuildMetricsFromPools(retainedPools, fallbackCounters);
    const routeObservationPoolSelection = selectDexRouteObservationPoolSet(
      [...retainedPools, ...(p4OnlyRetainedPools.get(id) ?? [])],
      retainedMeasuredRoutePools.get(id) ?? [],
    );
    const routeObservationResult = applyDexRouteObservationBounds(
      id,
      buildP4DexExitRouteObservations({
        stablecoinId: id,
        retainedPools: routeObservationPoolSelection.pools,
        observedAt: routeObservedAt,
      }),
      routeSelectionDiagnostics,
    );
    stripDexMeasuredExecutionInternalFields(retainedPools);
    // Persistence and price publication are read-only consumers of the same
    // sanitized pool graph. Sharing it avoids cloning thousands of rich pool
    // objects at the scoring peak.
    retainedPoolsByStablecoin.set(id, retainedPools);
    preparedRetainedPools.delete(id);
    p4OnlyRetainedPools.delete(id);

    applyRebuiltMetrics(m, rebuilt);
    const globalDelta = accumulateGlobalAggregate(
      retainedPools,
      globalProtocolTvl,
      globalChainTvl,
      globalProtoChainTvl,
      globalChains,
      seenPoolTvl,
    );
    globalTotalTvl += globalDelta.totalTvl;
    globalTotalVol24h += globalDelta.totalVol24h;
    globalTotalVol7d += globalDelta.totalVol7d;
    globalPoolCount += globalDelta.poolCount;

    // v2: Compute durability score
    const tvlStab = tvlStabilityMap.get(id) ?? null;
    const volStab = volumeStabilityMap.get(id) ?? null;
    const durability = computeDurabilityScore(m, tvlStab, volStab, fallbackCounters);

    // v2: Compute 6-component score
    const circulatingUsd = mcapById?.get(id);
    const { score, components } = computeLiquidityScore(m, durability, circulatingUsd, fallbackCounters);

    // v2: Compute aggregate metrics
    const weightedBalanceRatio = weightedRatio(m.balanceRatioWeightedSum, m.totalTvlForBalance);
    const organicFrac = weightedRatio(m.organicTvlWeightedSum, m.totalTvlForOrganic);
    // Stored diagnostic only: stress-unmeasured TVL contributes zero stress under the current methodology.
    const avgStress = weightedRatio(m.stressWeightedSum, m.totalTvlUsd, 2);
    const lockedLiqPct = weightedRatio(m.lockedLiqWeightedSum, m.totalTvlForLocked);
    const { coverageClass, coverageConfidence } = classifyCoverage({
      sourceMix: rebuilt.sourceMix,
      totalTvlUsd: m.totalTvlUsd,
      protocolCount: rebuilt.protocolCount,
      sourceFamilyCount: rebuilt.sourceFamilyCount,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
      syntheticTvlUsd: rebuilt.syntheticTvlUsd,
      decayedTvlUsd: rebuilt.decayedTvlUsd,
      measuredPriceTvlUsd: rebuilt.measuredPriceTvlUsd,
    });

    const fullScoreResult: P4aFullScoreResult = {
      tvl: m.totalTvlUsd,
      effectiveTvl: m.effectiveTvl,
      vol24h: m.totalVolume24hUsd,
      score,
      hhi: Math.round(rebuilt.hhi * 10000) / 10000,
      durability,
      components,
      weightedBalanceRatio,
      organicFrac,
      avgStress,
      lockedLiqPct,
      coverageClass,
      coverageConfidence,
      sourceMix: rebuilt.sourceMix,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
      exitRouteObservations: routeObservationResult.observations,
      exitRouteObservationCoverage: routeObservationResult.coverage,
    };
    results.set(id, fullScoreResult);
  }

  // Global protocol-level TVL cap: when reducing excess, chain TVLs are
  // distributed proportionally rather than attributed to the chain with the
  // most excess. Exact chain attribution would require per-pool chain data
  // which is not available in the global aggregate.
  //
  // Clamp deduped protocol totals at DL protocol TVL.
  // After cross-stablecoin dedup, a protocol can still exceed its real TVL when
  // CG/GT virtual reserves are inflated across many pools. The per-coin cap allows
  // up to protocolTvl PER stablecoin, but globally the protocol total must not
  // exceed DL's reported TVL. Chain TVLs are reduced proportionally.
  let globalCapReduction = 0;
  for (const proto of Object.keys(globalProtocolTvl)) {
    const cap = protocolTvlCaps.get(proto);
    if (cap != null && cap > 0 && globalProtocolTvl[proto] > cap) {
      const excess = globalProtocolTvl[proto] - cap;
      globalCapReduction += excess;
      // Distribute reduction to chain TVLs proportionally
      const protoTotal = globalProtocolTvl[proto];
      for (const [pcKey, pcTvl] of Object.entries(globalProtoChainTvl)) {
        if (!pcKey.startsWith(`${proto}:`)) continue;
        const chain = pcKey.slice(proto.length + 1);
        const chainReduction = (pcTvl / protoTotal) * excess;
        globalChainTvl[chain] = Math.max(0, (globalChainTvl[chain] ?? 0) - chainReduction);
      }
      globalProtocolTvl[proto] = cap;
    }
  }
  globalTotalTvl -= globalCapReduction;

  const globalAgg: GlobalAgg = {
    totalTvl: globalTotalTvl,
    totalVol24h: globalTotalVol24h,
    totalVol7d: globalTotalVol7d,
    totalVol7dMeasured: [...seenPoolTvl.values()].every((pool) => pool.vol7dMeasured),
    poolCount: globalPoolCount,
    chainCount: globalChains.size,
    protocolTvl: globalProtocolTvl,
    chainTvl: globalChainTvl,
  };

  return {
    scores: results,
    globalAgg,
    retainedPoolsByStablecoin,
    tvlStabilityMap,
    diagnostics: {
      protocolCapReductions: {
        cappedPoolCount: protocolCapDiagnostics.cappedPoolCount,
        cappedProtocols: protocolCapDiagnostics.cappedProtocols,
        reducedTvlUsd: protocolCapDiagnostics.reducedTvlUsd + Math.round(globalCapReduction),
      },
      fallbackCounters,
      routeSelection: routeSelectionDiagnostics,
      measuredExecution: {
        join: measuredExecutionJoin,
        inventoryTargetCount,
        shadowInventoryTargetCount,
        targetPublication,
        shadowTargetPublication,
        shadowAdmission,
      },
    },
  };
}
