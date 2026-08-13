import { ACTIVE_IDS, ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { roundTo } from "@shared/lib/math";
import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import {
  buildP4DexExitRouteObservations,
  type P4DexRouteObservationResult,
} from "@shared/lib/p4-exit-route-capacity";
import { MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "@shared/types/market";
import type { ExitRouteObservation, ExitRouteObservationCoverage } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { toErrorMessage } from "../../lib/error-utils";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexPriceObs, LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";
import type { TronMeasuredExecutionTarget } from "@shared/types/tron-measured-execution";
import { buildMeasuredPoolDirectionKey } from "../measured-execution/inventory";
import {
  applyDexMeasuredExecutionGate,
  buildDexMeasuredExecutionRetainedRoutePools,
  joinDexMeasuredExecutionEvidence,
  loadDexMeasuredExecutionJoinEvidence,
  releaseDexMeasuredExecutionProofFields,
  stripDexMeasuredExecutionInternalFields,
  type DexMeasuredExecutionJoinDiagnostics,
} from "../measured-execution/join";
import {
  publishDexMeasuredTargetInventory,
  publishDexShadowMeasuredTargetInventory,
  publishSolanaMeasuredTargetInventory,
  publishTronMeasuredTargetInventory,
} from "../measured-execution/persistence";
import { isDexMeasuredExecutionTargetScoreEligible } from "../measured-execution/sync";
import {
  buildDexMeasuredTargetFingerprintIndex,
  resolveDexMeasuredTargetForRetainedPool,
} from "../measured-execution/retained-target-resolution";
import { buildSolanaMeasuredPoolDirectionKey } from "../measured-execution/solana-inventory";
import { isSolanaMeasuredExecutionPriorityTargetScoreEligible } from "../measured-execution/solana-registry";
import {
  joinSolanaMeasuredExecutionEvidence,
  loadSolanaMeasuredExecutionJoinEvidence,
  releaseSolanaMeasuredExecutionProofFields,
  stripSolanaMeasuredExecutionInternalFields,
  type SolanaMeasuredExecutionJoinDiagnostics,
} from "../measured-execution/solana-join";
import { buildTronMeasuredPoolDirectionKey } from "../measured-execution/tron-inventory";
import {
  joinTronMeasuredExecutionEvidence,
  loadTronMeasuredExecutionJoinEvidence,
  releaseTronMeasuredExecutionProofFields,
  stripTronMeasuredExecutionInternalFields,
  type TronMeasuredExecutionJoinDiagnostics,
} from "../measured-execution/tron-join";
import { dexPriceConfidenceForSourceFamily } from "./constants";
import { computeDurabilityScore, computeLiquidityScore } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  accumulateGlobalAggregate,
  aggregateProtocolSources,
  applyProtocolCaps,
  applyRebuiltMetrics,
  buildDexPriceObservationsFromRetainedPools,
  classifyCoverage,
  collapseDuplicateObservations,
  filterRetainedPools,
  rebuildMetricsFromPools,
} from "./scoring-helpers";

/** Limit the lifetime of prepared statements carrying serialized price/depth data. */
export const DEX_LIQUIDITY_SCORING_BATCH_SIZE = 25;

const DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS = ACTIVE_STABLECOINS.length + 1;
const DEX_PRICE_STAGE_RETENTION_SEC = 3 * 60 * 60;
export const DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN = 8;

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
    (pool.extra?.measuredExecutions?.length ?? 0) > 0 ||
    pool.extra?.nativeMeasuredExecution !== undefined;
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

function selectDexRouteObservationPoolSet(
  currentPools: readonly LiquidityMetrics["topPools"][number][],
  retainedMeasuredPools: readonly LiquidityMetrics["topPools"][number][],
): DexRouteObservationPoolSelection {
  const byPhysicalPool = new Map<string, LiquidityMetrics["topPools"][number]>();
  for (const pool of [...currentPools, ...retainedMeasuredPools]) {
    const physicalPoolId =
      pool.extra?.nativeMeasuredExecutionPhysicalPoolId ??
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

// Named views of the one exit scoring engine's stress request, not a
// third copy of the same numbers.
export const V9_DEX_STRESS_NOTIONAL_USD = EXIT_ROUTE_SCORING_TABLES.request.capUsd;
export const V9_DEX_STRESS_MAX_COST_BPS = EXIT_ROUTE_SCORING_TABLES.request.maxCostBps;
const MAX_ROUTES_PER_CHAIN = 6;
const MAX_ROUTES_PER_PROTOCOL = 3;
const MAX_ROUTES_PER_ADAPTER = 3;

function executableCapacityAtV9Stress(observation: ExitRouteObservation): number {
  const point = observation.capacityCurve?.find(
    (candidate) =>
      candidate.requestedNotionalUsd === V9_DEX_STRESS_NOTIONAL_USD &&
      candidate.maxCostBps === V9_DEX_STRESS_MAX_COST_BPS,
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

interface DexRouteSelectionDiagnostic {
  stablecoinId: string;
  candidateObservationCount: number;
  publishedObservationCount: number;
  bestIncludedCapacityUsd: number;
  bestOmittedCapacityUsd: number;
  maxChainConcentration: number;
  maxProtocolConcentration: number;
}

function applyDexRouteObservationBounds(
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

const DEX_PRICE_EXACT_CURRENT_GENERATION_SQL = `
  SELECT generation.generation_id
  FROM dex_liquidity_publication_generations generation
  WHERE generation.generation_id = ?
    AND generation.state = 'published'
    AND generation.expected_row_count = ?
    AND generation.current_row_count = ?
    AND (SELECT COUNT(*)
         FROM dex_liquidity_run_rows staged
         WHERE staged.generation_id = generation.generation_id) = ?
    AND (SELECT COUNT(*)
         FROM dex_liquidity current
         WHERE current.publication_generation_id = generation.generation_id
           AND current.publication_state = 'published') = ?
    AND EXISTS (
      SELECT 1
      FROM dex_liquidity current_global
      WHERE current_global.stablecoin_id = '__global__'
        AND current_global.publication_generation_id = generation.generation_id
        AND current_global.publication_state = 'published'
    )
    AND (SELECT COUNT(*)
         FROM dex_price_run_rows price_stage
         WHERE price_stage.generation_id = generation.generation_id) = ?`;

function dexPriceExactCurrentGenerationBinds(generationId: string, priceRowCount: number): unknown[] {
  return [
    generationId,
    DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS,
    DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS,
    DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS,
    DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS,
    priceRowCount,
  ];
}

interface DexScoringGenerationCoverage {
  state: string;
  expected_row_count: number;
  current_row_count: number | null;
  staged_row_count: number;
  public_row_count: number;
}

export async function loadCurrentDexScoringGenerationId(
  db: D1Database,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  const row = await db
    .prepare(
      `SELECT generation_id
       FROM dex_liquidity_publication_generations
       WHERE state = 'published'
       ORDER BY published_at DESC, started_at DESC
       LIMIT 1`,
    )
    .first<{ generation_id: string }>();
  throwIfAborted(signal);
  return row?.generation_id?.trim() || null;
}

async function assertCurrentDexScoringGeneration(
  db: D1Database,
  generationId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const coverage = await db
    .prepare(
      `/* pharos:dex-scoring:current-generation */
       SELECT generation.state,
              generation.expected_row_count,
              generation.current_row_count,
              (SELECT COUNT(*)
               FROM dex_liquidity_run_rows staged
               WHERE staged.generation_id = generation.generation_id) AS staged_row_count,
              (SELECT COUNT(*)
               FROM dex_liquidity current
               WHERE current.publication_generation_id = generation.generation_id
                 AND current.publication_state = 'published') AS public_row_count
       FROM dex_liquidity_publication_generations generation
       WHERE generation.generation_id = ?`,
    )
    .bind(generationId)
    .first<DexScoringGenerationCoverage>();
  throwIfAborted(signal);

  if (
    coverage?.state !== "published" ||
    coverage.expected_row_count !== DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS ||
    coverage.current_row_count !== DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS ||
    coverage.staged_row_count !== DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS ||
    coverage.public_row_count !== DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS
  ) {
    throw new Error(
      `DEX scoring generation ${generationId} is not the complete current publication` +
        ` (state=${coverage?.state ?? "missing"}, expected=${coverage?.expected_row_count ?? 0},` +
        ` current=${coverage?.current_row_count ?? 0}, staged=${coverage?.staged_row_count ?? 0},` +
        ` public=${coverage?.public_row_count ?? 0})`,
    );
  }
}

/** @internal Exported for focused retention tests. */
export interface DexPriceStageRetentionResult {
  cutoff: number;
  deletedRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

export async function pruneExpiredDexPriceStages(
  db: D1Database,
  protectedGenerationId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexPriceStageRetentionResult> {
  const startedAtMs = Date.now();
  const cutoff = Math.max(0, Math.floor(nowSec) - DEX_PRICE_STAGE_RETENTION_SEC);
  const result: DexPriceStageRetentionResult = {
    cutoff,
    deletedRows: 0,
    oldestRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  try {
    throwIfAborted(signal);
    const deleted = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:dex-scoring:price-stage-retention */
           DELETE FROM dex_price_run_rows
           WHERE generation_id IN (
             SELECT candidate.generation_id
             FROM dex_price_run_rows candidate
             WHERE candidate.generation_id != ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM dex_liquidity current_global
                 WHERE current_global.stablecoin_id = '__global__'
                   AND current_global.publication_state = 'published'
                   AND current_global.publication_generation_id = candidate.generation_id
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM dex_liquidity_publication_generations active
                  WHERE active.generation_id = candidate.generation_id
                    AND active.state = 'staged'
               )
             GROUP BY candidate.generation_id
             HAVING MAX(candidate.updated_at) < ?
             ORDER BY MIN(candidate.updated_at), candidate.generation_id
             LIMIT ?
           )`,
        )
        .bind(
          protectedGenerationId,
          cutoff,
          DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN,
        )
        .run(),
      3,
      signal,
    );
    result.deletedRows = Number(deleted.meta?.changes ?? 0);
    const oldest = await runWithOverloadRetry(
      () => db
        .prepare("SELECT MIN(updated_at) AS oldest_remaining_at FROM dex_price_run_rows")
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

async function flushScoringStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  signal?: AbortSignal,
): Promise<void> {
  if (statements.length === 0) return;
  let batch: D1PreparedStatement[] | null = statements.splice(0, statements.length);
  try {
    await batchExecute(db, batch, {
      chunkSize: DEX_LIQUIDITY_SCORING_BATCH_SIZE,
      signal,
    });
  } finally {
    batch = null;
  }
}

const HISTORY_CONFIDENCE_MIN = 0.75;
const MIN_STABILITY_SAMPLES = 7;
const HISTORY_STABILITY_BATCH_SIZE = 512;
const PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO = 2.5;
const DISPLAY_PRICE_RATIO_MIN = 0.5,
  DISPLAY_PRICE_RATIO_MAX = 2.0;

function isP4OnlyPausedBalancerPool(pool: LiquidityMetrics["topPools"][number]): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "balancer-amm" && gate.reason === "paused-or-swap-disabled";
}

interface ProtocolCapDiagnostics {
  cappedPoolCount: number;
  cappedProtocols: number;
  reducedTvlUsd: number;
}

interface ScoreDiagnostics {
  protocolCapReductions: ProtocolCapDiagnostics;
  routeSelection: DexRouteSelectionDiagnostic[];
  measuredExecution: {
    join: DexMeasuredExecutionJoinDiagnostics;
    solanaJoin: SolanaMeasuredExecutionJoinDiagnostics;
    tronJoin: TronMeasuredExecutionJoinDiagnostics;
    inventoryTargetCount: number;
    shadowInventoryTargetCount: number;
    solanaInventoryTargetCount: number;
    tronInventoryTargetCount: number;
    targetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
    shadowTargetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
    solanaTargetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
    tronTargetPublication:
      | { status: "published"; generationId: string; rowCount: number }
      | { status: "skipped" | "failed"; reason: string };
  };
}

export type MeasuredTargetPublicationMode = "none" | "active" | "active-and-shadow";

type P4aFullScoreResult = FullScoreResult & {
  exitRouteObservations: ExitRouteObservation[];
  exitRouteObservationCoverage: ExitRouteObservationCoverage;
};

/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < MIN_STABILITY_SAMPLES) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}

function weightedRatio(sum: number, total: number, places = 4): number | null {
  return total > 0 ? roundTo(sum / total, places) : null;
}

/** @internal Exported for testing only. */
export async function loadConfidentHistoryStability(db: D1Database): Promise<{
  tvlStabilityMap: Map<string, number>;
  volumeStabilityMap: Map<string, number>;
}> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400;
  const thirtyDaysAgo = todayMidnight - 30 * 86_400;
  const tvlStabilityMap = new Map<string, number>();
  const volumeStabilityMap = new Map<string, number>();

  const tvlByCoin = new Map<string, number[]>();
  const volumeByCoin = new Map<string, number[]>();
  let cursorStablecoinId = "";
  let cursorSnapshotDate = -1;

  while (true) {
    const historyResult = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, total_tvl_usd, total_volume_24h_usd, coverage_confidence
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
           AND (stablecoin_id > ? OR (stablecoin_id = ? AND snapshot_date > ?))
         ORDER BY stablecoin_id, snapshot_date
         LIMIT ?`,
      )
      .bind(
        thirtyDaysAgo,
        cursorStablecoinId,
        cursorStablecoinId,
        cursorSnapshotDate,
        HISTORY_STABILITY_BATCH_SIZE,
      )
      .all<{
        stablecoin_id: string;
        snapshot_date: number;
        total_tvl_usd: number;
        total_volume_24h_usd: number;
        coverage_confidence: number | null;
      }>();
    const rows: Array<
      | {
          stablecoin_id: string;
          snapshot_date: number;
          total_tvl_usd: number;
          total_volume_24h_usd: number;
          coverage_confidence: number | null;
        }
      | undefined
    > = historyResult.results ?? [];
    const rowCount = rows.length;
    if (rowCount === 0) break;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      rows[rowIndex] = undefined;
      if (!row) continue;
      cursorStablecoinId = row.stablecoin_id;
      cursorSnapshotDate = row.snapshot_date;

      const confidence = row.coverage_confidence ?? 0;
      if (confidence < HISTORY_CONFIDENCE_MIN) continue;

      const tvlSeries = tvlByCoin.get(row.stablecoin_id) ?? [];
      tvlSeries.push(row.total_tvl_usd);
      tvlByCoin.set(row.stablecoin_id, tvlSeries);

      const volumeSeries = volumeByCoin.get(row.stablecoin_id) ?? [];
      volumeSeries.push(row.total_volume_24h_usd);
      volumeByCoin.set(row.stablecoin_id, volumeSeries);
    }
    rows.length = 0;
    if (rowCount < HISTORY_STABILITY_BATCH_SIZE) break;
  }

  for (const [coinId, tvls] of tvlByCoin) {
    const stability = computeSeriesStability(tvls);
    if (stability != null) {
      tvlStabilityMap.set(coinId, stability);
    }
  }
  for (const [coinId, volumes] of volumeByCoin) {
    const stability = computeSeriesStability(volumes);
    if (stability != null) {
      volumeStabilityMap.set(coinId, stability);
    }
  }

  return { tvlStabilityMap, volumeStabilityMap };
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
export async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  protocolTvlCaps: Map<string, number>,
  mcapById?: Map<string, number>,
  routeObservedAtSec = Math.floor(Date.now() / 1000),
  pancakeMeasuredTargets: Map<string, DexMeasuredExecutionTarget> = new Map(),
  fluidMeasuredTargets: Map<string, DexMeasuredExecutionTarget> = new Map(),
  signal?: AbortSignal,
  solanaMeasuredTargets: Map<string, SolanaMeasuredExecutionTarget> = new Map(),
  slipstreamMeasuredTargets: Map<string, DexMeasuredExecutionTarget> = new Map(),
  tronMeasuredTargets: Map<string, TronMeasuredExecutionTarget> = new Map(),
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
  const seenPoolTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
  const protocolCapDiagnostics: ProtocolCapDiagnostics = { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };
  const preparedRetainedPools = new Map<string, LiquidityMetrics["topPools"]>();
  const p4OnlyRetainedPools = new Map<string, LiquidityMetrics["topPools"]>();

  for (const [id, m] of [...metrics].filter(([stablecoinId]) => ACTIVE_IDS.has(stablecoinId))) {
    throwIfAborted(signal);
    p4OnlyRetainedPools.set(id, m.topPools.filter(isP4OnlyPausedBalancerPool));
    m.topPools = filterRetainedPools(m.topPools.filter((pool) => !isP4OnlyPausedBalancerPool(pool)));
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
          : pool.project === "fluid" && pool.poolType.includes("fluid")
            ? fluidMeasuredTargets.get(buildMeasuredPoolDirectionKey(id, pool.poolId))
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
          : pool.project === "fluid"
            ? "fluid-resolver-measured"
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
    for (const pool of retainedPools) {
      const adapterProfileId =
        pool.project === "raydium" && pool.poolType === "raydium-clmm"
          ? "raydium-clmm-trade-api-v1"
          : pool.project === "orca" && pool.poolType === "orca-whirlpool"
            ? "orca-whirlpool-jupiter-v1"
            : null;
      if (!adapterProfileId) continue;
      const candidate = solanaMeasuredTargets.get(buildSolanaMeasuredPoolDirectionKey(id, pool.poolId));
      pool.extra = { ...(pool.extra ?? {}) };
      if (!candidate || candidate.adapterProfileId !== adapterProfileId) {
        delete pool.extra.solanaMeasuredExecutionTarget;
        delete pool.extra.solanaMeasuredExecution;
        delete pool.extra.solanaMeasuredExecutionProfile;
        delete pool.extra.solanaMeasuredExecutionPhysicalPoolId;
        pool.extra.executionCapabilityGate = { family: "measured-execution", reason: "target-unresolved" };
        pool.extra.solanaMeasuredExecutionDiagnostic = { adapterProfileId };
        continue;
      }
      pool.extra.solanaMeasuredExecutionTarget = {
        ...candidate,
        retainedTvlUsd: pool.tvlUsd,
        capturedAt: routeObservedAt,
      };
      pool.extra.solanaMeasuredExecutionPhysicalPoolId = candidate.poolId;
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.solanaMeasuredExecutionDiagnostic = {
        adapterProfileId: candidate.adapterProfileId,
        targetId: candidate.targetId,
      };
    }
    for (const pool of retainedPools) {
      if (!pool.project.includes("sunswap")) continue;
      const adapterProfileId = "sunswap-v2-router-v1";
      const candidate = tronMeasuredTargets.get(buildTronMeasuredPoolDirectionKey(id, pool.poolId));
      pool.extra = { ...(pool.extra ?? {}) };
      if (!candidate || candidate.adapterProfileId !== adapterProfileId) {
        delete pool.extra.tronMeasuredExecutionTarget;
        delete pool.extra.tronMeasuredExecution;
        delete pool.extra.tronMeasuredExecutionProfile;
        delete pool.extra.tronMeasuredExecutionPhysicalPoolId;
        pool.extra.executionCapabilityGate = { family: "measured-execution", reason: "target-unresolved" };
        pool.extra.tronMeasuredExecutionDiagnostic = { adapterProfileId };
        continue;
      }
      pool.extra.tronMeasuredExecutionTarget = {
        ...candidate,
        retainedTvlUsd: pool.tvlUsd,
        capturedAt: routeObservedAt,
      };
      pool.extra.tronMeasuredExecutionPhysicalPoolId = candidate.poolId;
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.tronMeasuredExecutionDiagnostic = {
        adapterProfileId: candidate.adapterProfileId,
        targetId: candidate.targetId,
      };
    }
    preparedRetainedPools.set(id, retainedPools);
  }

  const targetInventoryById = new Map<string, DexMeasuredExecutionTarget>();
  const solanaTargetInventoryById = new Map<string, SolanaMeasuredExecutionTarget>();
  const tronTargetInventoryById = new Map(
    [...tronMeasuredTargets.values()].map((target) => [target.targetId, target] as const),
  );
  for (const pools of preparedRetainedPools.values()) {
    for (const pool of pools) {
      for (const target of pool.extra?.measuredExecutionTargets ?? []) {
        targetInventoryById.set(target.targetId, target);
      }
      const target = pool.extra?.measuredExecutionTarget;
      if (target) targetInventoryById.set(target.targetId, target);
      const solanaTarget = pool.extra?.solanaMeasuredExecutionTarget;
      if (solanaTarget) solanaTargetInventoryById.set(solanaTarget.targetId, solanaTarget);
      const tronTarget = pool.extra?.tronMeasuredExecutionTarget;
      if (tronTarget) tronTargetInventoryById.set(tronTarget.targetId, tronTarget);
    }
  }
  // The adjusted target inventory and retained pools now own every downstream
  // descriptor. Release the producer maps before proof-heavy evidence is loaded.
  pancakeMeasuredTargets.clear();
  fluidMeasuredTargets.clear();
  solanaMeasuredTargets.clear();
  slipstreamMeasuredTargets.clear();
  slipstreamMeasuredTargetsByFingerprint.clear();
  tronMeasuredTargets.clear();

  const activeTargetInventory = [...targetInventoryById.values()].filter(isDexMeasuredExecutionTargetScoreEligible);
  const shadowTargetInventory = [...targetInventoryById.values()].filter(
    (target) => !isDexMeasuredExecutionTargetScoreEligible(target),
  );
  const inventoryTargetCount = activeTargetInventory.length;
  const shadowInventoryTargetCount = shadowTargetInventory.length;
  const solanaInventoryTargetCount = solanaTargetInventoryById.size;
  const scoreFacingSolanaTargetIds = [...solanaTargetInventoryById.values()]
    .filter(isSolanaMeasuredExecutionPriorityTargetScoreEligible)
    .map((target) => target.targetId);
  const tronInventoryTargetCount = tronTargetInventoryById.size;
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
  let solanaTargetPublication: ScoreDiagnostics["measuredExecution"]["solanaTargetPublication"];
  if (measuredTargetPublicationMode !== "active-and-shadow") {
    solanaTargetPublication = { status: "skipped", reason: "daily-shadow-publication-not-due" };
  } else if (solanaInventoryTargetCount === 0) {
    solanaTargetPublication = { status: "skipped", reason: "no-applicable-targets" };
  } else {
    try {
      const publication = await publishSolanaMeasuredTargetInventory({
        db,
        targets: [...solanaTargetInventoryById.values()],
        capturedAt: routeObservedAt,
        signal,
      });
      solanaTargetPublication = { status: "published", ...publication };
    } catch (error) {
      rethrowIfAborted(error, signal);
      solanaTargetPublication = { status: "failed", reason: String(error).slice(0, 500) };
    } finally {
      solanaTargetInventoryById.clear();
    }
  }
  let tronTargetPublication: ScoreDiagnostics["measuredExecution"]["tronTargetPublication"];
  if (measuredTargetPublicationMode !== "active-and-shadow") {
    tronTargetPublication = { status: "skipped", reason: "daily-shadow-publication-not-due" };
  } else if (tronInventoryTargetCount === 0) {
    tronTargetPublication = { status: "skipped", reason: "no-applicable-targets" };
  } else {
    try {
      const publication = await publishTronMeasuredTargetInventory({
        db,
        targets: [...tronTargetInventoryById.values()],
        capturedAt: routeObservedAt,
        signal,
      });
      tronTargetPublication = { status: "published", ...publication };
    } catch (error) {
      rethrowIfAborted(error, signal);
      tronTargetPublication = { status: "failed", reason: String(error).slice(0, 500) };
    } finally {
      tronTargetInventoryById.clear();
    }
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
  const solanaJoinEvidence = scoreFacingSolanaTargetIds.length > 0
    ? await loadSolanaMeasuredExecutionJoinEvidence(db, signal, scoreFacingSolanaTargetIds)
    : null;
  const solanaMeasuredExecutionJoin = joinSolanaMeasuredExecutionEvidence({
    poolsByStablecoin: preparedRetainedPools,
    evidence: solanaJoinEvidence,
    nowSec: routeObservedAt,
  });
  for (const pools of preparedRetainedPools.values()) {
    releaseSolanaMeasuredExecutionProofFields(pools);
  }
  solanaJoinEvidence?.byTargetId.clear();
  const tronJoinEvidence = await loadTronMeasuredExecutionJoinEvidence(db, signal);
  const tronMeasuredExecutionJoin = joinTronMeasuredExecutionEvidence({
    poolsByStablecoin: preparedRetainedPools,
    evidence: tronJoinEvidence,
    nowSec: routeObservedAt,
  });
  for (const pools of preparedRetainedPools.values()) {
    releaseTronMeasuredExecutionProofFields(pools);
  }
  tronJoinEvidence?.byTargetId.clear();

  for (const [id, m] of [...metrics].filter(([stablecoinId]) => ACTIVE_IDS.has(stablecoinId))) {
    throwIfAborted(signal);
    const retainedPools = preparedRetainedPools.get(id) ?? [];
    const rebuilt = rebuildMetricsFromPools(retainedPools);
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
    stripSolanaMeasuredExecutionInternalFields(retainedPools);
    stripTronMeasuredExecutionInternalFields(retainedPools);
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
    const durability = computeDurabilityScore(m, tvlStab, volStab);

    // v2: Compute 6-component score
    const circulatingUsd = mcapById?.get(id);
    const { score, components } = computeLiquidityScore(m, durability, circulatingUsd);

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
      routeSelection: routeSelectionDiagnostics,
      measuredExecution: {
        join: measuredExecutionJoin,
        solanaJoin: solanaMeasuredExecutionJoin,
        tronJoin: tronMeasuredExecutionJoin,
        inventoryTargetCount,
        shadowInventoryTargetCount,
        solanaInventoryTargetCount,
        tronInventoryTargetCount,
        targetPublication,
        shadowTargetPublication,
        solanaTargetPublication,
        tronTargetPublication,
      },
    },
  };
}

/** Compute depth stability (CV-based) and persist to D1. Accepts pre-loaded data to avoid redundant DB scan. */
export async function computeDepthStability(
  db: D1Database,
  preloadedTvlStabilityMap: Map<string, number> | undefined,
  generationId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!generationId.trim()) throw new Error("DEX depth stability requires a publication generation id");
  throwIfAborted(signal);
  const tvlStabilityMap = preloadedTvlStabilityMap ?? (await loadConfidentHistoryStability(db)).tvlStabilityMap;
  await assertCurrentDexScoringGeneration(db, generationId, signal);

  const stabilityStmts: D1PreparedStatement[] = [];
  const queueStabilityStatement = async (statement: D1PreparedStatement): Promise<void> => {
    stabilityStmts.push(statement);
    if (stabilityStmts.length >= DEX_LIQUIDITY_SCORING_BATCH_SIZE) {
      await flushScoringStatements(db, stabilityStmts, signal);
    }
  };
  await queueStabilityStatement(
    db
      .prepare(
        `UPDATE dex_liquidity_run_rows
         SET depth_stability = NULL
         WHERE generation_id = ? AND stablecoin_id != '__global__'`,
      )
      .bind(generationId),
  );
  let stagedStabilityCount = 0;
  for (const [id, stability] of tvlStabilityMap) {
    throwIfAborted(signal);
    if (!ACTIVE_IDS.has(id)) continue;
    stagedStabilityCount++;
    await queueStabilityStatement(
      db
        .prepare(
          `UPDATE dex_liquidity_run_rows
           SET depth_stability = ?
           WHERE stablecoin_id = ? AND generation_id = ?`,
        )
        .bind(stability, id, generationId),
    );
  }
  await flushScoringStatements(db, stabilityStmts, signal);

  const staged = await db
    .prepare(
      `/* pharos:dex-scoring:depth-stage-coverage */
       SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN depth_stability IS NOT NULL THEN 1 ELSE 0 END), 0) AS stability_count
       FROM dex_liquidity_run_rows
       WHERE generation_id = ? AND stablecoin_id != '__global__'`,
    )
    .bind(generationId)
    .first<{ row_count: number; stability_count: number }>();
  if (staged?.row_count !== ACTIVE_STABLECOINS.length || staged.stability_count !== stagedStabilityCount) {
    throw new Error(
      `Incomplete DEX depth stability stage for ${generationId}` +
        ` (rows=${staged?.row_count ?? 0}/${ACTIVE_STABLECOINS.length},` +
        ` values=${staged?.stability_count ?? 0}/${stagedStabilityCount})`,
    );
  }

  await assertCurrentDexScoringGeneration(db, generationId, signal);
  const publishedChanges = await executeAtomicBatch(
    db,
    [
      db
        .prepare(
          `UPDATE dex_liquidity
           SET depth_stability = (
             SELECT staged.depth_stability
             FROM dex_liquidity_run_rows staged
             WHERE staged.generation_id = ?
               AND staged.stablecoin_id = dex_liquidity.stablecoin_id
           )
           WHERE publication_generation_id = ?
             AND publication_state = 'published'
             AND stablecoin_id != '__global__'`,
        )
        .bind(generationId, generationId),
    ],
    { signal },
  );
  if (publishedChanges !== ACTIVE_STABLECOINS.length) {
    throw new Error(
      `DEX depth stability publication changed ${publishedChanges}/${ACTIVE_STABLECOINS.length} current rows`,
    );
  }
  console.log(`[dex-liquidity] Published depth stability for ${stagedStabilityCount} coins from ${generationId}`);
}

/** Compute DEX-implied prices from the final retained pool set and persist to dex_prices. */
export interface DexPricePersistenceDiagnostics {
  rejectedObservationCount: number;
  rejectedByStablecoin: Array<{
    stablecoinId: string;
    reason: "peg-impossible";
    observations: Array<{
      chain: string;
      protocol: string;
      poolKey: string | null;
      price: number;
      tvl: number;
      sourceFamily: string | null;
    }>;
    truncated: number;
  }>;
  truncatedStablecoins: number;
  retention?: DexPriceStageRetentionResult;
}

const MAX_DEX_PRICE_REJECTION_ASSETS = 20;
const MAX_DEX_PRICE_REJECTIONS_PER_ASSET = 5;

export async function computeDexPrices(
  db: D1Database,
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  nowSec: number,
  references?: PriceValidationReferences,
  signal?: AbortSignal,
  exactPriceEvidenceByStablecoin?: Map<string, DexPriceObs[]>,
  generationId = `dex-liquidity-${nowSec}`,
  preloadedPrimaryPrices?: Map<string, number>,
): Promise<DexPricePersistenceDiagnostics> {
  if (!generationId.trim()) throw new Error("DEX price publication requires a generation id");
  throwIfAborted(signal);
  await assertCurrentDexScoringGeneration(db, generationId, signal);
  const retention = await pruneExpiredDexPriceStages(db, generationId, nowSec, signal);
  if (retention.error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "expired_price_stage_prune_failed",
      job: "sync-dex-liquidity",
      message: "Failed to prune expired DEX price stages",
      error: retention.error,
    });
  }
  const existingRows = await db.prepare("SELECT stablecoin_id FROM dex_prices").all<{ stablecoin_id: string }>();
  const existingIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));
  throwIfAborted(signal);
  await db.prepare("DELETE FROM dex_price_run_rows WHERE generation_id = ?").bind(generationId).run();
  throwIfAborted(signal);

  const primaryPrices = new Map(preloadedPrimaryPrices);
  // A supplied map is already trust-filtered; missing entries are intentional.
  let loadedStrictPrimaryPrices = preloadedPrimaryPrices !== undefined;
  const loadPrimaryPrices = async (stablecoinId: string): Promise<Map<string, number>> => {
    if (primaryPrices.has(stablecoinId) || loadedStrictPrimaryPrices) return primaryPrices;
    loadedStrictPrimaryPrices = true;
    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
    if (stablecoinsCache.kind === "ok") {
      for (const asset of stablecoinsCache.payload.peggedAssets) {
        if (
          !primaryPrices.has(asset.id)
          && asset.price != null
          && typeof asset.price === "number"
          && asset.price > 0
        ) {
          primaryPrices.set(asset.id, asset.price);
        }
      }
    }
    return primaryPrices;
  };

  const priceStmts: D1PreparedStatement[] = [];
  const queuePriceStatement = async (statement: D1PreparedStatement): Promise<void> => {
    priceStmts.push(statement);
    if (priceStmts.length >= DEX_LIQUIDITY_SCORING_BATCH_SIZE) {
      await flushScoringStatements(db, priceStmts, signal);
    }
  };
  const observedIds = new Set<string>();
  let collapsedDuplicateGroups = 0;
  let collapsedDuplicateObservations = 0;
  let rejectedObservationCount = 0;
  let rejectedStablecoinCount = 0;
  const rejectedByStablecoin: DexPricePersistenceDiagnostics["rejectedByStablecoin"] = [];
  for (const [id, retainedPools] of retainedPoolsByStablecoin) {
    throwIfAborted(signal);
    const observations =
      buildDexPriceObservationsFromRetainedPools(new Map([[id, retainedPools]]), exactPriceEvidenceByStablecoin).get(
        id,
      ) ?? [];
    if (observations.length === 0) continue;
    const prices = await loadPrimaryPrices(id);

    const {
      collapsed: collapsedObservations,
      duplicateGroups,
      duplicateObservations,
    } = collapseDuplicateObservations(observations);
    collapsedDuplicateGroups += duplicateGroups;
    collapsedDuplicateObservations += duplicateObservations;
    if (collapsedObservations.length === 0) continue;

    // Validate before selecting the aggregate so an impossible quote cannot
    // enter dex_prices while merely being hidden from price_sources_json.
    const plausibleObservations: DexPriceObs[] = [];
    const rejectedObservations: DexPriceObs[] = [];
    for (const observation of collapsedObservations) {
      (isPlausibleDexObservationPrice(id, observation.price, references)
        ? plausibleObservations
        : rejectedObservations
      ).push(observation);
    }
    if (rejectedObservations.length > 0) {
      rejectedObservationCount += rejectedObservations.length;
      rejectedStablecoinCount++;
      if (rejectedByStablecoin.length < MAX_DEX_PRICE_REJECTION_ASSETS) {
        rejectedByStablecoin.push({
          stablecoinId: id,
          reason: "peg-impossible",
          observations: rejectedObservations.slice(0, MAX_DEX_PRICE_REJECTIONS_PER_ASSET).map((observation) => ({
            chain: observation.chain,
            protocol: observation.protocol,
            poolKey: observation.poolKey ?? null,
            price: observation.price,
            tvl: observation.tvl,
            sourceFamily: observation.sourceFamily ?? null,
          })),
          truncated: Math.max(0, rejectedObservations.length - MAX_DEX_PRICE_REJECTIONS_PER_ASSET),
        });
      }
    }
    if (plausibleObservations.length === 0) continue;
    observedIds.add(id);

    // Look up primary price early — used for outlier filtering and deviation calc
    const primaryPrice = prices.get(id);

    // Filter extreme outliers relative to primary price before computing median.
    // When a source (e.g. CoinGecko aggregate) reports a price near peg for a severely
    // depegged stablecoin, its high TVL can dominate the TVL-weighted median.
    // Only apply when 3+ observations exist and majority by count agrees with primary.
    let medianInputObs = plausibleObservations;
    if (primaryPrice != null && primaryPrice > 0 && plausibleObservations.length >= 3) {
      const nearPrimary = plausibleObservations.filter((o) => {
        const ratio = o.price / primaryPrice;
        return (
          ratio >= 1 / PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO && ratio <= PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO
        );
      });
      if (nearPrimary.length >= 2 && nearPrimary.length > plausibleObservations.length / 2) {
        medianInputObs = nearPrimary;
      }
    }

    // Scale TVL weights by source confidence before computing median
    const adjustedObs = medianInputObs.map((o) => ({
      ...o,
      tvl: o.tvl * dexPriceConfidenceForSourceFamily(o.sourceFamily),
    }));

    // TVL-weighted median: sort by price, walk until cumulative (confidence-weighted) TVL crosses 50%
    adjustedObs.sort((a, b) => a.price - b.price);
    const adjustedTotalTvl = adjustedObs.reduce((s, o) => s + o.tvl, 0);
    const halfTvl = adjustedTotalTvl / 2;
    let cumTvl = 0;
    let medianPrice = adjustedObs[0].price;
    for (const obs of adjustedObs) {
      cumTvl += obs.tvl;
      if (cumTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }

    // Raw TVL for DB storage (represents actual on-chain liquidity, not confidence-weighted)
    const totalTvl = plausibleObservations.reduce((s, o) => s + o.tvl, 0);
    let deviationBps: number | null = null;
    if (primaryPrice != null && primaryPrice > 0) {
      deviationBps = Math.round((medianPrice / primaryPrice - 1) * 10000);
    }

    // Guard against retained pools whose prices are off-peg for the tracked stablecoin.
    // This protects price_sources_json (the "show all sources" UI) from alias-collapse
    // contamination like Fantom USDC.e rows at $0.044 flowing into usdc-circle.priceSources.
    // The scoring-level sanity gate has a wide 1% floor to avoid rejecting legitimately
    // depegged stablecoins. For the per-protocol display surface, apply a tighter 50%
    // primary-price ratio guard on top so near-peg alias-collapse rows are filtered.
    const sanePriceObs = plausibleObservations.filter((obs) => {
      if (primaryPrice != null && primaryPrice > 0) {
        const ratio = obs.price / primaryPrice;
        if (ratio < DISPLAY_PRICE_RATIO_MIN || ratio > DISPLAY_PRICE_RATIO_MAX) return false;
      }
      return true;
    });
    const protocolSources = aggregateProtocolSources(sanePriceObs);

    const meta = TRACKED_META_BY_ID.get(id);
    const symbol = meta?.symbol ?? id;

    await queuePriceStatement(
      db
        .prepare(
          `INSERT INTO dex_price_run_rows
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at, generation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(generation_id, stablecoin_id) DO UPDATE SET
            symbol = excluded.symbol,
            dex_price_usd = excluded.dex_price_usd,
            source_pool_count = excluded.source_pool_count,
            source_total_tvl = excluded.source_total_tvl,
            deviation_from_primary_bps = excluded.deviation_from_primary_bps,
            primary_price_at_calc = excluded.primary_price_at_calc,
            price_sources_json = excluded.price_sources_json,
            updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          symbol,
          Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
          plausibleObservations.length,
          Math.round(totalTvl),
          deviationBps,
          primaryPrice ?? null,
          JSON.stringify(protocolSources),
          nowSec,
          generationId,
        ),
    );
  }

  let retiredCount = 0;
  for (const existingId of existingIds) {
    throwIfAborted(signal);
    if (observedIds.has(existingId)) continue;
    retiredCount++;
  }

  await flushScoringStatements(db, priceStmts, signal);
  const staged = await db
    .prepare(
      `/* pharos:dex-scoring:price-stage-coverage */
       SELECT COUNT(*) AS row_count
       FROM dex_price_run_rows
       WHERE generation_id = ?`,
    )
    .bind(generationId)
    .first<{ row_count: number }>();
  if (staged?.row_count !== observedIds.size) {
    throw new Error(
      `Incomplete DEX price stage for ${generationId} (rows=${staged?.row_count ?? 0}/${observedIds.size})`,
    );
  }

  await assertCurrentDexScoringGeneration(db, generationId, signal);
  const exactGenerationBinds = dexPriceExactCurrentGenerationBinds(generationId, observedIds.size);
  const publishedChanges = await executeAtomicBatch(
    db,
    [
      db
        .prepare(
          `/* pharos:dex-scoring:price-publication-fence */
           UPDATE dex_liquidity_publication_generations
           SET written_row_count = written_row_count
           WHERE generation_id = (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})`,
        )
        .bind(...exactGenerationBinds),
      db
        .prepare(
          `DELETE FROM dex_prices
           WHERE EXISTS (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})`,
        )
        .bind(...exactGenerationBinds),
      db
        .prepare(
          `INSERT INTO dex_prices
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
           SELECT stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
                  deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at
           FROM dex_price_run_rows staged_price
           WHERE staged_price.generation_id = ?
             AND EXISTS (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})
           ORDER BY staged_price.stablecoin_id`,
        )
        .bind(generationId, ...exactGenerationBinds),
    ],
    { signal },
  );
  const allowedPublishedChanges = new Set([1 + existingIds.size + observedIds.size, 1 + observedIds.size * 2]);
  if (!allowedPublishedChanges.has(publishedChanges)) {
    throw new Error(
      `DEX price publication fence/replacement changed ${publishedChanges} rows for ${generationId}` +
        ` (expected one of ${[...allowedPublishedChanges].join(", ")})`,
    );
  }

  const published = await db
    .prepare(
      `/* pharos:dex-scoring:price-publication-coverage */
       SELECT (SELECT COUNT(*) FROM dex_prices) AS public_row_count,
              (SELECT COUNT(*) FROM dex_prices WHERE updated_at = ?) AS generation_row_count,
              (SELECT COUNT(*) FROM dex_price_run_rows WHERE generation_id = ?) AS staged_row_count`,
    )
    .bind(nowSec, generationId)
    .first<{ public_row_count: number; generation_row_count: number; staged_row_count: number }>();
  if (
    published?.public_row_count !== observedIds.size ||
    published.generation_row_count !== observedIds.size ||
    published.staged_row_count !== observedIds.size
  ) {
    throw new Error(
      `Incomplete DEX price publication for ${generationId}` +
        ` (public=${published?.public_row_count ?? 0}/${observedIds.size},` +
        ` generation=${published?.generation_row_count ?? 0}/${observedIds.size},` +
        ` staged=${published?.staged_row_count ?? 0}/${observedIds.size})`,
    );
  }
  // The sentinel tracks the live DEX publication pipeline (prices hourly), while
  // endpoint freshness is derived from the score rows' own two-hour timestamp.
  await writeFreshnessSentinel(db, "dex-liquidity", nowSec, signal);

  try {
    const cleanup = await db.prepare("DELETE FROM dex_price_run_rows WHERE generation_id = ?").bind(generationId).run();
    const cleanedRows = Number(cleanup.meta?.changes ?? 0);
    if (cleanedRows !== observedIds.size) {
      console.warn(
        `[dex-liquidity] DEX price stage cleanup removed ${cleanedRows}/${observedIds.size} rows for ${generationId}`,
      );
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    console.warn(`[dex-liquidity] Failed to clean published DEX price stage ${generationId}: ${String(error)}`);
  }

  if (observedIds.size > 0 || retiredCount > 0) {
    console.log(
      `[dex-liquidity] Wrote ${observedIds.size} DEX price observations to dex_prices` +
        (collapsedDuplicateGroups > 0
          ? ` after collapsing ${collapsedDuplicateObservations} duplicate observations across ${collapsedDuplicateGroups} pool group(s)`
          : "") +
        (retiredCount > 0 ? ` and retired ${retiredCount} stale rows` : ""),
    );
  }
  return {
    rejectedObservationCount,
    rejectedByStablecoin,
    truncatedStablecoins: Math.max(0, rejectedStablecoinCount - rejectedByStablecoin.length),
    retention,
  };
}
