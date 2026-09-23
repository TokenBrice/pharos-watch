import { logWorkerEventArgs } from "../../lib/structured-log";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import { getCache, getCaches, setCacheIfNewer } from "../../lib/db-cache";
import {
  computeSafetyScoresSnapshot,
  type PublishedSafetyScoresResultMap,
} from "../../lib/safety-scores";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config";
import {
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  parseYieldSupplementalSourcesCache,
  serializeDeterministicOnChainHealthState,
  getYieldSupplementalFamilyCacheKey,
  type DeterministicOnChainHealthState,
} from "./cache";
import { DETERMINISTIC_ONCHAIN_COOLDOWN_SEC } from "./cache/normalization";
import {
  getYieldSupplementalRunOutcomeCacheKey,
  parseYieldSupplementalRunOutcomeDetailed,
  getYieldSupplementalPendleBackoffCacheKey,
  parseYieldSupplementalPendleBackoff,
  PENDLE_RATE_LIMIT_BACKOFF_REASON,
} from "./cache/supplemental-cache-keys";
import { fetchOnChainRates, loadDlStablecoinPools, loadRiskFreeRateRegistry } from "./sources";
import {
  loadStablecoinSupplyMapFromCacheValue,
  type StablecoinSupplyMapLoadResult,
  type StablecoinSupplyMapState,
} from "./supply-map";
import { getSupplementalFamilyStaleThresholdSec } from "./supplemental-source-families";
import {
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "./supplemental-source-family-keys";
import type { ResolvedYieldCandidate } from "./types";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
const DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY = "yield:onchain-health:v1";
const DETERMINISTIC_ONCHAIN_COOLDOWN_THRESHOLD = 2;

export interface YieldSupplementalCacheMeta {
  mode: "cache" | "stale-cache" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  sourceCount: number;
  fallbackMode: string | null;
  /**
   * B1/B16: families whose last producer run ended degraded and therefore kept
   * the previous snapshot (`sync-yield-supplemental` run-outcome row). Empty
   * when no run outcome is stored yet.
   */
  degradedFamilies: string[];
  /**
   * PENDLE-RL (R4): machine-readable cause per degraded family from the
   * run-outcome row (e.g. `pendle-rate-limited-backoff`). Rows written before
   * the field existed parse as no reasons.
   */
  degradedFamilyReasons?: Partial<Record<string, string>>;
}

export interface YieldSyncLoadedState {
  dlPools: Awaited<ReturnType<typeof loadDlStablecoinPools>>["pools"];
  dlPoolsMeta: YieldSourceInputMeta;
  /** SRC-SUPP-3: DL pool rows dropped by the APY envelope during this load. */
  dlApyEnvelopeRejectedCount: number;
  supplementalCandidates: ResolvedYieldCandidate[];
  supplementalMeta: YieldSupplementalCacheMeta;
  onChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownRemainingSec: number;
  onChainSkippedDueToCooldown: boolean;
  onChainRates: Map<string, { rate: number; sourceTvlUsd?: number | null }>;
  onChainFailures: Record<string, number> | null;
  onChainAttemptedCount: number;
  allDeterministicFailed: boolean;
  onChainExplorerAttemptedCount: number;
  onChainExplorerResolvedCount: number;
  riskFreeRates: Awaited<ReturnType<typeof loadRiskFreeRateRegistry>>;
  riskFreeRateMeta: YieldBenchmarkMeta;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  safetySnapshot: PublishedSafetyScoresResultMap;
  safetyScores: PublishedSafetyScoresResultMap["scores"];
  safetyCoverageRatio: number;
  /** A score map can be used: a current publication, or a held accepted one inside the read-path budget. */
  safetySnapshotAvailable: boolean;
  /** True when the canonical publication health is held (accepted generation still served). */
  safetySnapshotHeld: boolean;
  /** Age of the accepted publication, or null when no publication identity is published. */
  acceptedSafetyPublicationAgeSeconds: number | null;
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
  let latestFamilyRowUpdatedAt: number | null = null;
  let invalidFamilyCacheRows = 0;
  let staleFamilyCacheRows = 0;
  let presentFamilyCacheRows = 0;

  const runOutcomeCacheKey = getYieldSupplementalRunOutcomeCacheKey();
  const familyCacheRows = await getCaches(
    db,
    [
      ...SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => getYieldSupplementalFamilyCacheKey(family)),
      runOutcomeCacheKey,
      getYieldSupplementalPendleBackoffCacheKey(),
    ],
  );
  const runOutcomeRow = familyCacheRows.get(runOutcomeCacheKey) ?? null;
  const runOutcome = runOutcomeRow ? parseYieldSupplementalRunOutcomeDetailed(runOutcomeRow.value) : null;
  const degradedFamilies = runOutcome?.degradedFamilies ?? [];
  const degradedFamilyReasons = runOutcome?.degradedFamilyReasons ?? {};
  for (const family of SUPPLEMENTAL_SOURCE_FAMILY_KEYS) {
    const cachedFamily = familyCacheRows.get(getYieldSupplementalFamilyCacheKey(family)) ?? null;
    if (!cachedFamily) continue;
    presentFamilyCacheRows += 1;
    latestFamilyRowUpdatedAt = Math.max(latestFamilyRowUpdatedAt ?? 0, cachedFamily.updatedAt);
    const requiredFamily = requiredFamilyKeys.has(family);
    if (requiredFamily) requiredFamilyCacheRows += 1;
    const parsedFamily = parseYieldSupplementalSourcesCache(cachedFamily.value, cachedFamily.updatedAt, startSec);
    if (!parsedFamily) {
      invalidFamilyCacheRows += 1;
      if (requiredFamily) degradedRequiredFamilyCaches += 1;
      continue;
    }
    if (parsedFamily.ageSeconds > getSupplementalFamilyStaleThresholdSec(family)) {
      staleFamilyCacheRows += 1;
      if (requiredFamily) degradedRequiredFamilyCaches += 1;
      continue;
    }
    validFamilyKeys.add(family);
    familyCandidates.push(...parsedFamily.candidates);
    latestFamilyUpdatedAt = Math.max(latestFamilyUpdatedAt ?? 0, parsedFamily.updatedAt);
  }
  // Backoff can outlive a clean producer run. Re-evaluate it hourly as the
  // retained row crosses its budget, without waiting for another fetch slot.
  const pendleBackoff = parseYieldSupplementalPendleBackoff(
    familyCacheRows.get(getYieldSupplementalPendleBackoffCacheKey())?.value,
    startSec,
  );
  if (pendleBackoff && !validFamilyKeys.has("pendle")) {
    if (!degradedFamilies.includes("pendle")) degradedFamilies.push("pendle");
    degradedFamilyReasons.pendle = PENDLE_RATE_LIMIT_BACKOFF_REASON;
  }

  if (validFamilyKeys.size > 0) {
    const missingOrDegradedFamily =
      degradedRequiredFamilyCaches > 0
      || requiredFamilyCacheRows < REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length;
    const candidates = familyCandidates;
    const fallbackMode: string | null = missingOrDegradedFamily ? "partial-family-cache" : null;
    const updatedAt = latestFamilyUpdatedAt;

    const ageSeconds = updatedAt == null ? null : Math.max(0, startSec - updatedAt);
    return {
      candidates,
      meta: {
        mode: "cache",
        updatedAt,
        ageSeconds,
        sourceCount: candidates.length,
        fallbackMode,
        degradedFamilies,
        degradedFamilyReasons,
      },
    };
  }

  return {
    candidates: [],
    meta: {
      mode: staleFamilyCacheRows > 0 && invalidFamilyCacheRows === 0 ? "stale-cache" : "unavailable",
      updatedAt: latestFamilyRowUpdatedAt,
      ageSeconds: latestFamilyRowUpdatedAt == null ? null : Math.max(0, startSec - latestFamilyRowUpdatedAt),
      sourceCount: 0,
      fallbackMode:
        presentFamilyCacheRows === 0
          ? "missing-cache"
          : invalidFamilyCacheRows > 0
            ? "invalid-cache"
            : "stale-cache",
      degradedFamilies,
      degradedFamilyReasons,
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

async function loadStablecoinSupplyMap(db: D1Database): Promise<StablecoinSupplyMapLoadResult> {
  // R2: a failed read must never become a claim about the data. This used to
  // catch the D1 error and return `malformed`, which made an unreachable cache
  // indistinguishable from a genuinely unparseable payload — the run then
  // published `fallbackMode: yield-supply-map:malformed` and silently dropped every
  // external-opportunity row the fail-closed gate could not size. The read is
  // idempotent and overload-retried inside `getCache`, so an exhausted read
  // belongs to the run as a visible failure with the previous generation
  // retained; only real payload problems keep the `malformed` state.
  const cacheRow = await getCache(db, "stablecoins");
  const result = loadStablecoinSupplyMapFromCacheValue(cacheRow?.value);
  if (result.state === "malformed") {
    logWorkerEventArgs(
      "handler",
      "warn",
      "[sync-yield-data] Failed to parse stablecoins cache for lending size gates",
    );
  }
  return result;
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
    stablecoinSupplyMap,
  ] = await Promise.all([
    loadDlStablecoinPools(params.db, params.signal),
    loadYieldSupplementalCandidates(params.db, params.startSec),
    getCache(params.db, DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY),
    loadRiskFreeRateRegistry(params.db),
    loadStablecoinSupplyMap(params.db),
  ]);
  const { pools: dlPools, meta: dlPoolsMeta, envelopeRejectedCount } = dlPoolsResult;
  const dlApyEnvelopeRejectedCount = envelopeRejectedCount ?? 0;
  const { candidates: supplementalCandidates, meta: supplementalMeta } = supplementalResult;
  const onChainHealthState = onChainHealthCache
    ? parseDeterministicOnChainHealthState(onChainHealthCache.value, params.startSec)
    : getDefaultDeterministicOnChainHealthState();
  const onChainSkippedDueToCooldown =
    ON_CHAIN_RATE_CONFIGS.length > 0 &&
    onChainHealthState.cooldownUntil != null &&
    onChainHealthState.cooldownUntil > params.startSec;
  const onChainCooldownRemainingSec =
    onChainSkippedDueToCooldown && onChainHealthState.cooldownUntil != null
      ? Math.max(0, onChainHealthState.cooldownUntil - params.startSec)
      : 0;
  const onChainFetchResultPromise = onChainSkippedDueToCooldown
    ? {
        rates: new Map<string, { rate: number; sourceTvlUsd?: number | null }>(),
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

  const { state: stablecoinSupplyMapState, supplyById: stablecoinSupplyById } = stablecoinSupplyMap;
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  // `computeSafetyScoresSnapshot` reports `kind: "degraded"` for exactly two
  // states: no published generation at all (always with a null identity) and a
  // health-held publication (always with the accepted generation's identity).
  // A hold rejects the newest attempt; the accepted ratings stay the ones the
  // report-card surfaces serve, so the yield lane may publish against them
  // inside the same budget the read path uses before it blanks safety to NR.
  const safetySnapshotIdentityPresent = safetySnapshot.safetyScoreIdentity != null;
  const acceptedSafetyPublicationAgeSeconds =
    safetySnapshot.publishedAt == null ? null : Math.max(0, params.startSec - safetySnapshot.publishedAt);
  const safetySnapshotHeld = safetySnapshot.kind === "degraded" && safetySnapshotIdentityPresent;
  const safetySnapshotWithinHeldBudget =
    safetySnapshotHeld &&
    acceptedSafetyPublicationAgeSeconds != null &&
    acceptedSafetyPublicationAgeSeconds <= YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC;
  const safetySnapshotAvailable =
    safetySnapshotIdentityPresent &&
    (safetySnapshot.kind === "ok" || safetySnapshotWithinHeldBudget);
  // A held publication never counts as a clean safety input: the run stays
  // degraded (and skips destructive cleanup) while it publishes.
  const safetySnapshotDegraded =
    !safetySnapshotAvailable || safetySnapshotHeld || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  return {
    dlPools,
    dlPoolsMeta,
    dlApyEnvelopeRejectedCount,
    supplementalCandidates,
    supplementalMeta,
    onChainHealthState,
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
    stablecoinSupplyMapState,
    safetySnapshot,
    safetyScores,
    safetyCoverageRatio,
    safetySnapshotAvailable,
    safetySnapshotHeld,
    acceptedSafetyPublicationAgeSeconds,
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
