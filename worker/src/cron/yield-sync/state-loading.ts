import { getCirculatingRaw } from "@shared/lib/supply";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import {
  computeSafetyScoresSnapshot,
  type SafetyScoresResultMap,
} from "../../lib/safety-scores";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronStageContext } from "../shared/stage-contracts";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import {
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  parseYieldSupplementalSourcesCache,
  serializeDeterministicOnChainHealthState,
  type DeterministicOnChainHealthState,
} from "./cache";
import { fetchOnChainRates, loadDlStablecoinPools, loadRiskFreeRateRegistry } from "./sources";
import type { ResolvedYieldCandidate } from "./types";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
const YIELD_SUPPLEMENTAL_CACHE_KEY = "yield:supplemental-sources:v1";
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
  safetySnapshot: SafetyScoresResultMap;
  safetyScores: Map<string, { score: number; grade: string }>;
  safetyCoverageRatio: number;
  safetySnapshotDegraded: boolean;
}

function buildStablecoinSupplyMapFromCacheValue(value: string): Map<string, number> {
  const parsed = JSON.parse(value) as unknown;
  const rawAssets =
    Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { peggedAssets?: unknown }).peggedAssets)
        ? (parsed as { peggedAssets: unknown[] }).peggedAssets
        : []);
  const supplyById = new Map<string, number>();

  for (const asset of rawAssets) {
    if (!asset || typeof asset !== "object") continue;
    const id = (asset as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const supplyUsd = getCirculatingRaw(asset as Parameters<typeof getCirculatingRaw>[0]);
    if (supplyUsd > 0) {
      supplyById.set(id, supplyUsd);
    }
  }

  return supplyById;
}

async function loadYieldSupplementalCandidates(
  db: D1Database,
  startSec: number,
): Promise<{ candidates: ResolvedYieldCandidate[]; meta: YieldSupplementalCacheMeta }> {
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
  signal?: CronStageContext["signal"];
  chainRpcs?: Map<string, ChainRpcConfig>;
  etherscanApiKey?: string | null;
}): Promise<YieldSyncLoadedState> {
  const { pools: dlPools, meta: dlPoolsMeta } = await loadDlStablecoinPools(params.db, params.signal);
  const { candidates: supplementalCandidates, meta: supplementalMeta } = await loadYieldSupplementalCandidates(
    params.db,
    params.startSec,
  );
  const onChainHealthCache = await getCache(params.db, DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY);
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
  const onChainFetchResult = onChainSkippedDueToCooldown
    ? {
        rates: new Map<string, { rate: number }>(),
        failureBreakdown: null as Record<string, number> | null,
        attemptedCount: 0,
        allDeterministicFailed: false,
        explorerAttemptedCount: 0,
        explorerResolvedCount: 0,
      }
    : await fetchOnChainRates(params.signal, params.chainRpcs, params.etherscanApiKey);
  const {
    rates: onChainRates,
    failureBreakdown: onChainFailures,
    attemptedCount: onChainAttemptedCount = 0,
    allDeterministicFailed = false,
    explorerAttemptedCount: onChainExplorerAttemptedCount = 0,
    explorerResolvedCount: onChainExplorerResolvedCount = 0,
  } = onChainFetchResult;
  const riskFreeRates = await loadRiskFreeRateRegistry(params.db);
  const riskFreeRateMeta = riskFreeRates.USD;

  const stablecoinSupplyById = new Map<string, number>();
  const stablecoinsCache = await getCache(params.db, "stablecoins");
  if (stablecoinsCache?.value) {
    try {
      for (const [id, supplyUsd] of buildStablecoinSupplyMapFromCacheValue(stablecoinsCache.value)) {
        stablecoinSupplyById.set(id, supplyUsd);
      }
    } catch (error) {
      console.warn("[sync-yield-data] Failed to parse stablecoins cache for lending size gates:", error);
    }
  }

  const safetySnapshot = await computeSafetyScoresSnapshot(params.db, {
    includeNavTokens: true,
    outputMode: "map",
  });
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  const safetySnapshotDegraded =
    safetySnapshot.kind !== "ok" || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

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
