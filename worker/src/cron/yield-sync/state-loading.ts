import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { getCache, getCaches, setCacheIfNewer } from "../../lib/db-cache";
import {
  computeSafetyScoresSnapshot,
  type PublishedSafetyScoresResultMap,
} from "../../lib/safety-scores";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import {
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  parseYieldSupplementalSourcesCache,
  serializeDeterministicOnChainHealthState,
  getYieldSupplementalFamilyCacheKey,
  YIELD_SUPPLEMENTAL_CACHE_KEY,
  type DeterministicOnChainHealthState,
} from "./cache";
import { fetchOnChainRates, loadDlStablecoinPools, loadRiskFreeRateRegistry } from "./sources";
import { buildStablecoinSupplyMapFromCacheValue } from "./supply-map";
import {
  getSupplementalCandidateFamily,
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "./supplemental-source-families";
import type { SupplementalSourceFamilyKey } from "./supplemental-source-family-keys";
import type { ResolvedYieldCandidate } from "./types";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
const DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY = "yield:onchain-health:v1";
const YIELD_SUPPLEMENTAL_MAX_AGE_SEC = 12 * 3600;
const DETERMINISTIC_ONCHAIN_COOLDOWN_THRESHOLD = 2;
const DETERMINISTIC_ONCHAIN_COOLDOWN_SEC = 6 * 3600;

export interface YieldSupplementalCacheMeta {
  mode: "cache" | "stale-cache" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  sourceCount: number;
  fallbackMode: string | null;
}

export interface YieldSyncLoadedState {
  dlPools: Awaited<ReturnType<typeof loadDlStablecoinPools>>["pools"];
  dlPoolsMeta: YieldSourceInputMeta;
  supplementalCandidates: ResolvedYieldCandidate[];
  supplementalMeta: YieldSupplementalCacheMeta;
  onChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownActive: boolean;
  onChainCooldownRemainingSec: number;
  onChainSkippedDueToCooldown: boolean;
  onChainRates: Map<string, { rate: number }>;
  onChainFailures: Record<string, number> | null;
  onChainAttemptedCount: number;
  allDeterministicFailed: boolean;
  onChainExplorerAttemptedCount: number;
  onChainExplorerResolvedCount: number;
  riskFreeRates: Awaited<ReturnType<typeof loadRiskFreeRateRegistry>>;
  riskFreeRateMeta: YieldBenchmarkMeta;
  stablecoinSupplyById: Map<string, number>;
  safetySnapshot: PublishedSafetyScoresResultMap;
  safetyScores: PublishedSafetyScoresResultMap["scores"];
  safetyCoverageRatio: number;
  safetySnapshotAvailable: boolean;
  safetySnapshotDegraded: boolean;
}

async function loadYieldSupplementalCandidates(
  db: D1Database,
  startSec: number,
): Promise<{ candidates: ResolvedYieldCandidate[]; meta: YieldSupplementalCacheMeta }> {
  const familyCandidates: ResolvedYieldCandidate[] = [];
  const validFamilyKeys = new Set<SupplementalSourceFamilyKey>();
  const requiredFamilyKeys = new Set(REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS);
  let requiredFamilyCacheRows = 0;
  let degradedRequiredFamilyCaches = 0;
  let latestFamilyUpdatedAt: number | null = null;

  const familyCacheRows = await getCaches(
    db,
    SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => getYieldSupplementalFamilyCacheKey(family)),
  );
  for (const family of SUPPLEMENTAL_SOURCE_FAMILY_KEYS) {
    const cachedFamily = familyCacheRows.get(getYieldSupplementalFamilyCacheKey(family)) ?? null;
    if (!cachedFamily) continue;
    const requiredFamily = requiredFamilyKeys.has(family);
    if (requiredFamily) requiredFamilyCacheRows += 1;
    const parsedFamily = parseYieldSupplementalSourcesCache(cachedFamily.value, cachedFamily.updatedAt, startSec);
    if (!parsedFamily || parsedFamily.ageSeconds > YIELD_SUPPLEMENTAL_MAX_AGE_SEC) {
      if (requiredFamily) degradedRequiredFamilyCaches += 1;
      continue;
    }
    validFamilyKeys.add(family);
    familyCandidates.push(...parsedFamily.candidates);
    latestFamilyUpdatedAt = Math.max(latestFamilyUpdatedAt ?? 0, parsedFamily.updatedAt);
  }

  if (familyCandidates.length > 0) {
    const missingOrDegradedFamily =
      degradedRequiredFamilyCaches > 0
      || requiredFamilyCacheRows < REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length;
    let candidates = familyCandidates;
    let fallbackMode: string | null = missingOrDegradedFamily ? "partial-family-cache" : null;
    let updatedAt = latestFamilyUpdatedAt;

    if (missingOrDegradedFamily) {
      const cachedAggregate = await getCache(db, YIELD_SUPPLEMENTAL_CACHE_KEY);
      const parsedAggregate = cachedAggregate
        ? parseYieldSupplementalSourcesCache(cachedAggregate.value, cachedAggregate.updatedAt, startSec)
        : null;
      if (parsedAggregate && parsedAggregate.ageSeconds <= YIELD_SUPPLEMENTAL_MAX_AGE_SEC) {
        const aggregateBackfill = parsedAggregate.candidates.filter((candidate) => {
          const family = getSupplementalCandidateFamily(candidate.yield?.sourceKey);
          return family == null || !validFamilyKeys.has(family);
        });
        if (aggregateBackfill.length > 0) {
          candidates = [...familyCandidates, ...aggregateBackfill];
          updatedAt = Math.max(updatedAt ?? 0, parsedAggregate.updatedAt);
          fallbackMode = "partial-family-cache-aggregate-merge";
        }
      }
    }

    const ageSeconds = updatedAt == null ? null : Math.max(0, startSec - updatedAt);
    return {
      candidates,
      meta: {
        mode: "cache",
        updatedAt,
        ageSeconds,
        sourceCount: candidates.length,
        fallbackMode,
      },
    };
  }

  const cached = await getCache(db, YIELD_SUPPLEMENTAL_CACHE_KEY);
  if (!cached) {
    return {
      candidates: [],
      meta: {
        mode: "unavailable",
        updatedAt: null,
        ageSeconds: null,
        sourceCount: 0,
        fallbackMode: "missing-cache",
      },
    };
  }

  const parsed = parseYieldSupplementalSourcesCache(cached.value, cached.updatedAt, startSec);
  if (!parsed) {
    return {
      candidates: [],
      meta: {
        mode: "unavailable",
        updatedAt: cached.updatedAt,
        ageSeconds: Math.max(0, startSec - cached.updatedAt),
        sourceCount: 0,
        fallbackMode: "invalid-cache",
      },
    };
  }

  if (parsed.ageSeconds > YIELD_SUPPLEMENTAL_MAX_AGE_SEC) {
    return {
      candidates: [],
      meta: {
        mode: "stale-cache",
        updatedAt: parsed.updatedAt,
        ageSeconds: parsed.ageSeconds,
        sourceCount: parsed.sourceCount,
        fallbackMode: "stale-cache",
      },
    };
  }

  return {
    candidates: parsed.candidates,
    meta: {
      mode: "cache",
      updatedAt: parsed.updatedAt,
      ageSeconds: parsed.ageSeconds,
      sourceCount: parsed.sourceCount,
      fallbackMode: null,
    },
  };
}

export function buildNextDeterministicOnChainHealthState(params: {
  deterministicConfigCount: number;
  previous: DeterministicOnChainHealthState;
  startSec: number;
  onChainAttemptedCount: number;
  onChainRatesResolved: number;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  onChainSkippedDueToCooldown: boolean;
}): DeterministicOnChainHealthState {
  const {
    deterministicConfigCount,
    previous,
    startSec,
    onChainAttemptedCount,
    onChainRatesResolved,
    allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown,
  } = params;

  if (deterministicConfigCount === 0) {
    return getDefaultDeterministicOnChainHealthState();
  }

  if (onChainSkippedDueToCooldown) {
    if (onChainAlternativeCoverageMissingIds.length > 0) {
      return {
        ...getDefaultDeterministicOnChainHealthState(),
        lastSkippedAt: startSec,
        lastFailureMissingIds: onChainAlternativeCoverageMissingIds,
      };
    }
    return {
      ...previous,
      lastSkippedAt: startSec,
    };
  }

  if (onChainAttemptedCount === 0) {
    return {
      ...previous,
      cooldownUntil:
        previous.cooldownUntil != null && previous.cooldownUntil > startSec
          ? previous.cooldownUntil
          : null,
    };
  }

  if (onChainRatesResolved > 0) {
    return {
      ...getDefaultDeterministicOnChainHealthState(),
      lastAttemptedAt: startSec,
      lastSuccessAt: startSec,
    };
  }

  if (allDeterministicFailed) {
    const consecutiveAllFailRuns = previous.consecutiveAllFailRuns + 1;
    const consecutiveMaskedAllFailRuns = maskedAllDeterministicFailure
      ? previous.consecutiveMaskedAllFailRuns + 1
      : 0;
    return {
      consecutiveAllFailRuns,
      consecutiveMaskedAllFailRuns,
      cooldownUntil:
        maskedAllDeterministicFailure && consecutiveMaskedAllFailRuns >= DETERMINISTIC_ONCHAIN_COOLDOWN_THRESHOLD
          ? startSec + DETERMINISTIC_ONCHAIN_COOLDOWN_SEC
          : null,
      lastAttemptedAt: startSec,
      lastAllFailedAt: startSec,
      lastSuccessAt: previous.lastSuccessAt,
      lastSkippedAt: previous.lastSkippedAt,
      lastFailureMissingIds: onChainAlternativeCoverageMissingIds,
    };
  }

  return {
    ...getDefaultDeterministicOnChainHealthState(),
    lastAttemptedAt: startSec,
  };
}

export async function loadYieldSyncState(params: {
  db: D1Database;
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  etherscanApiKey?: string | null;
}): Promise<YieldSyncLoadedState> {
  const [
    dlPoolsResult,
    supplementalResult,
    onChainHealthCache,
    riskFreeRates,
    stablecoinsCacheRow,
  ] = await Promise.all([
    loadDlStablecoinPools(params.db, params.signal),
    loadYieldSupplementalCandidates(params.db, params.startSec),
    getCache(params.db, DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY),
    loadRiskFreeRateRegistry(params.db),
    getCache(params.db, "stablecoins"),
  ]);
  const { pools: dlPools, meta: dlPoolsMeta } = dlPoolsResult;
  const { candidates: supplementalCandidates, meta: supplementalMeta } = supplementalResult;
  const onChainHealthState = onChainHealthCache
    ? parseDeterministicOnChainHealthState(onChainHealthCache.value)
    : getDefaultDeterministicOnChainHealthState();
  const onChainCooldownActive =
    ON_CHAIN_RATE_CONFIGS.length > 0 &&
    onChainHealthState.cooldownUntil != null &&
    onChainHealthState.cooldownUntil > params.startSec;
  const onChainCooldownRemainingSec =
    onChainCooldownActive && onChainHealthState.cooldownUntil != null
      ? Math.max(0, onChainHealthState.cooldownUntil - params.startSec)
      : 0;
  const onChainSkippedDueToCooldown = onChainCooldownActive;
  const onChainFetchResultPromise = onChainSkippedDueToCooldown
    ? {
        rates: new Map<string, { rate: number }>(),
        failureBreakdown: null as Record<string, number> | null,
        attemptedCount: 0,
        allDeterministicFailed: false,
        explorerAttemptedCount: 0,
        explorerResolvedCount: 0,
      }
    : fetchOnChainRates(params.signal, params.chainRpcs, params.etherscanApiKey);
  const safetySnapshotPromise = computeSafetyScoresSnapshot(params.db);
  const [onChainFetchResult, safetySnapshot] = await Promise.all([
    onChainFetchResultPromise,
    safetySnapshotPromise,
  ]);
  const {
    rates: onChainRates,
    failureBreakdown: onChainFailures,
    attemptedCount: onChainAttemptedCount = 0,
    allDeterministicFailed = false,
    explorerAttemptedCount: onChainExplorerAttemptedCount = 0,
    explorerResolvedCount: onChainExplorerResolvedCount = 0,
  } = onChainFetchResult;
  const riskFreeRateMeta = riskFreeRates.USD;

  const stablecoinSupplyById = new Map<string, number>();
  if (stablecoinsCacheRow?.value) {
    try {
      for (const [id, supplyUsd] of buildStablecoinSupplyMapFromCacheValue(stablecoinsCacheRow.value)) {
        stablecoinSupplyById.set(id, supplyUsd);
      }
    } catch (error) {
      console.warn("[sync-yield-data] Failed to parse stablecoins cache for lending size gates:", error);
    }
  }
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  const safetySnapshotAvailable =
    safetySnapshot.kind === "ok" && safetySnapshot.safetyScoreIdentity != null;
  const safetySnapshotDegraded =
    !safetySnapshotAvailable || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  return {
    dlPools,
    dlPoolsMeta,
    supplementalCandidates,
    supplementalMeta,
    onChainHealthState,
    onChainCooldownActive,
    onChainCooldownRemainingSec,
    onChainSkippedDueToCooldown,
    onChainRates,
    onChainFailures,
    onChainAttemptedCount,
    allDeterministicFailed,
    onChainExplorerAttemptedCount,
    onChainExplorerResolvedCount,
    riskFreeRates,
    riskFreeRateMeta,
    stablecoinSupplyById,
    safetySnapshot,
    safetyScores,
    safetyCoverageRatio,
    safetySnapshotAvailable,
    safetySnapshotDegraded,
  };
}

export async function persistDeterministicOnChainHealthState(
  db: D1Database,
  startSec: number,
  state: DeterministicOnChainHealthState,
): Promise<void> {
  await setCacheIfNewer(
    db,
    DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY,
    serializeDeterministicOnChainHealthState(state),
    startSec,
  );
}
