import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import {
  getCache,
  getCaches,
  setCacheIfNewer,
} from "../../lib/db-cache";
import {
  computeApyFromPrice,
  isDeterministicApyWithinSanityBounds,
} from "../yield-helpers";
import {
  buildHardcodedUsdBenchmark,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import {
  parseRiskFreeRateCache,
  parseRiskFreeRatesCacheDetailed,
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  parseYieldSupplementalSourcesCache,
  serializeDeterministicOnChainHealthState,
  getYieldSupplementalFamilyCacheKey,
  type DeterministicOnChainHealthState,
  DETERMINISTIC_ONCHAIN_COOLDOWN_SEC,
  getYieldSupplementalRunOutcomeCacheKey,
  parseYieldSupplementalRunOutcomeDetailed,
  getYieldSupplementalPendleBackoffCacheKey,
  parseYieldSupplementalPendleBackoff,
  PENDLE_RATE_LIMIT_BACKOFF_REASON,
  supplementalFamilySnapshotHash,
} from "./cache";
import {
  getCirculatingRawOrNull,
} from "@shared/lib/supply";
import {
  logWorkerEventArgs,
} from "../../lib/structured-log";
import type {
  YieldBenchmarkMeta,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import {
  isYieldSafetyFallbackWithinWindow,
} from "@shared/lib/yield-safety-fallback";
import {
  STATUS_YIELD_HEALTH_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import {
  computeSafetyScoresSnapshot,
  type PublishedSafetyScoresResultMap,
} from "../../lib/safety-scores";
import type {
  ChainRpcConfig,
} from "../../lib/chain-registry";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import {
  fetchOnChainRates,
} from "./sources-rpc";
import {
  loadDlStablecoinPools,
} from "./sources-dl";
import {
  getSupplementalFamilyStaleThresholdSec,
} from "./family-registry";
import {
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "./family-registry";
import type {
  ResolvedYieldCandidate,
} from "./types";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";

export async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<{
  apy: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number;
} | null> {
  const now = Math.floor(Date.now() / 1000);
  const minLookbackSec = 7 * DAY_SECONDS;
  const maxLookbackSec = 45 * DAY_SECONDS;

  const [recentRow, anchoredRow] = await Promise.all([
    db
      .prepare(
        "SELECT price, snapshot_date, price_observed_at FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ price: number; snapshot_date: number; price_observed_at: number | null }>(),
    db
      .prepare(
        `SELECT price, snapshot_date, price_observed_at
         FROM supply_history
         WHERE stablecoin_id = ?
           AND price IS NOT NULL
           AND snapshot_date BETWEEN ? AND ?
         ORDER BY snapshot_date ASC
         LIMIT 1`,
      )
      .bind(stablecoinId, now - maxLookbackSec, now - minLookbackSec)
      .first<{ price: number; snapshot_date: number; price_observed_at: number | null }>(),
  ]);

  if (!recentRow?.price || !anchoredRow?.price || anchoredRow.price <= 0) return null;

  // `snapshot_date` is a UTC day bucket, not an observation clock. The quote's
  // own clock (migration 0253) is the only admissible observation time; a row
  // without one was not observed by this pipeline and cannot yield an APY.
  const isObservationClock = (value: number | null): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= now;
  if (!isObservationClock(recentRow.price_observed_at) || !isObservationClock(anchoredRow.price_observed_at)) {
    return null;
  }

  const lookbackDays = (recentRow.snapshot_date - anchoredRow.snapshot_date) / DAY_SECONDS;
  if (!Number.isFinite(lookbackDays) || lookbackDays < 7) return null;
  const apy = computeApyFromPrice(recentRow.price, anchoredRow.price, lookbackDays);
  if (typeof apy !== "number" || !isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    apy,
    sourceObservedAt: recentRow.price_observed_at,
    comparisonAnchorObservedAt: anchoredRow.price_observed_at,
  };
}

function emptyBenchmarkRegistry(usd: ParsedYieldBenchmarkMeta): ParsedYieldBenchmarkRegistry {
  return {
    USD: usd,
    USD_EFFR: null,
    EUR: null,
    CHF: null,
    GBP: null,
    JPY: null,
    MXN: null,
    BRL: null,
    AUD: null,
    CAD: null,
    RUB: null,
    TRY: null,
    SGD: null,
  };
}

/**
 * Readability of the cached `risk_free_rates` row this load started from.
 * `invalid` means the row or its required USD member could not be parsed;
 * `missing` means there was no row. Callers that publish the registry use this
 * to avoid stamping a placeholder snapshot over unreadable required evidence.
 */
export type RiskFreeRateRegistryCacheState = "valid" | "invalid" | "missing";

export interface LoadedRiskFreeRateRegistry {
  registry: ParsedYieldBenchmarkRegistry;
  cacheState: RiskFreeRateRegistryCacheState;
}

/**
 * Load the benchmark registry and the readability state of its cache row.
 * A USD sub-entry that does not parse degrades USD alone — every
 * other readable key is kept, and USD prefers the readable legacy scalar row
 * over the hardcoded fallback.
 */
export async function loadRiskFreeRateRegistryWithState(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<LoadedRiskFreeRateRegistry> {
  const registryCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  const parsedRegistry = registryCache
    ? parseRiskFreeRatesCacheDetailed(registryCache.value, registryCache.updatedAt, nowSec)
    : null;

  if (parsedRegistry && !parsedRegistry.invalidKeys.includes("USD")) {
    return { registry: parsedRegistry.registry, cacheState: "valid" };
  }

  const legacyUsdCache = await getCache(db, LEGACY_USD_RISK_FREE_RATE_CACHE_KEY);
  const legacyUsd = legacyUsdCache
    ? parseRiskFreeRateCache(legacyUsdCache.value, legacyUsdCache.updatedAt, nowSec, { key: "USD" })
    : null;

  if (parsedRegistry) {
    return {
      registry: { ...parsedRegistry.registry, USD: legacyUsd ?? parsedRegistry.registry.USD },
      cacheState: "invalid",
    };
  }

  if (legacyUsd) {
    return {
      registry: emptyBenchmarkRegistry(legacyUsd),
      cacheState: registryCache ? "invalid" : "missing",
    };
  }

  return {
    registry: emptyBenchmarkRegistry(
      buildHardcodedUsdBenchmark(
        registryCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
      ),
    ),
    cacheState: registryCache ? "invalid" : "missing",
  };
}

export type StablecoinSupplyMapState = "ok" | "missing" | "malformed";

export interface StablecoinSupplyMapLoadResult {
  state: StablecoinSupplyMapState;
  supplyById: Map<string, number>;
}

function buildStablecoinSupplyMapFromCacheValue(value: string): Map<string, number> {
  const parsed = JSON.parse(value) as unknown;
  const rawAssets = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "peggedAssets" in parsed && Array.isArray(parsed.peggedAssets)
      ? parsed.peggedAssets
      : null;
  if (!rawAssets) {
    throw new Error("Stablecoins cache payload must be an array or contain peggedAssets");
  }
  const supplyById = new Map<string, number>();

  for (const asset of rawAssets) {
    if (!asset || typeof asset !== "object") continue;
    const id = (asset as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const supplyUsd = getCirculatingRawOrNull(asset as Parameters<typeof getCirculatingRawOrNull>[0]);
    if (supplyUsd !== null && supplyUsd > 0) {
      supplyById.set(id, supplyUsd);
    }
  }

  return supplyById;
}

export function loadStablecoinSupplyMapFromCacheValue(
  value: string | null | undefined,
): StablecoinSupplyMapLoadResult {
  if (value == null) {
    return { state: "missing", supplyById: new Map() };
  }
  try {
    return { state: "ok", supplyById: buildStablecoinSupplyMapFromCacheValue(value) };
  } catch {
    return { state: "malformed", supplyById: new Map() };
  }
}

const DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY = "yield:onchain-health:v1";
const DETERMINISTIC_ONCHAIN_COOLDOWN_THRESHOLD = 2;

export interface YieldSupplementalCacheMeta {
  mode: "cache" | "stale-cache" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  sourceCount: number;
  fallbackMode: string | null;
  /** Required snapshots absent, invalid, or outside their family freshness budget. */
  unavailableRequiredFamilies?: string[];
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
  /** Outcome absent or obsolete for these exact consumed family snapshots. */
  unknownOutcomeFamilies?: string[];
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
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  riskFreeRateRegistryCacheState: RiskFreeRateRegistryCacheState;
  riskFreeRateMeta: YieldBenchmarkMeta;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  safetySnapshot: PublishedSafetyScoresResultMap;
  safetyScores: PublishedSafetyScoresResultMap["scores"];
  safetyCoverageRatio: number | null;
  /** Current and held accepted publications share the original safety-clock budget. */
  safetySnapshotAvailable: boolean;
  safetySnapshotUnavailableReason: string | null;
  /** True when the canonical publication health is held (accepted generation still served). */
  safetySnapshotHeld: boolean;
  /** Age of the original accepted publication, or null when its clock is invalid. */
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
  const unknownOutcomeFamilies = SUPPLEMENTAL_SOURCE_FAMILY_KEYS.filter((family) =>
    runOutcome?.familySnapshotHashes[family] !== supplementalFamilySnapshotHash(
      familyCacheRows.get(getYieldSupplementalFamilyCacheKey(family)) ?? null));
  const degradedFamilies = (runOutcome?.degradedFamilies ?? []).filter((family) => !unknownOutcomeFamilies.includes(family));
  const degradedFamilyReasons = Object.fromEntries(degradedFamilies.flatMap((family) =>
    runOutcome?.degradedFamilyReasons[family] ? [[family, runOutcome.degradedFamilyReasons[family]]] : []));
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
        unavailableRequiredFamilies: REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.filter((key) => !validFamilyKeys.has(key)),
        degradedFamilies,
        degradedFamilyReasons,
        unknownOutcomeFamilies,
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
      unavailableRequiredFamilies: [...REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS],
      degradedFamilies,
      degradedFamilyReasons,
      unknownOutcomeFamilies,
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
    riskFreeRateRegistry,
    stablecoinSupplyMap,
  ] = await Promise.all([
    loadDlStablecoinPools(params.db, params.signal),
    loadYieldSupplementalCandidates(params.db, params.startSec),
    getCache(params.db, DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY),
    loadRiskFreeRateRegistryWithState(params.db, params.startSec),
    loadStablecoinSupplyMap(params.db),
  ]);
  const { registry: riskFreeRates, cacheState: riskFreeRateRegistryCacheState } = riskFreeRateRegistry;
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
    safetySnapshot.publishedAt != null && Number.isFinite(safetySnapshot.publishedAt) && safetySnapshot.publishedAt <= params.startSec
      ? params.startSec - safetySnapshot.publishedAt : null;
  const safetySnapshotHeld = safetySnapshot.kind === "degraded" && safetySnapshotIdentityPresent;
  const safetySnapshotWithinBudget =
    isYieldSafetyFallbackWithinWindow(params.startSec, safetySnapshot.publishedAt, params.startSec);
  const safetySnapshotAvailable = safetySnapshotIdentityPresent && safetySnapshotWithinBudget;
  const safetySnapshotUnavailableReason = safetySnapshotAvailable ? null
    : safetySnapshotIdentityPresent ? "safety-publication-clock-out-of-budget"
      : safetySnapshot.reason ?? "safety-score-v9-publication:identity-missing";
  // Held accepted evidence is advisory, but still suppresses destructive cleanup.
  const safetySnapshotDegraded =
    !safetySnapshotAvailable ||
    safetyCoverageRatio == null ||
    safetyCoverageRatio < STATUS_YIELD_HEALTH_THRESHOLDS.safetyCoverageRatio;

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
    riskFreeRateRegistryCacheState,
    riskFreeRateMeta,
    stablecoinSupplyById,
    stablecoinSupplyMapState,
    safetySnapshot,
    safetyScores,
    safetyCoverageRatio,
    safetySnapshotAvailable,
    safetySnapshotUnavailableReason,
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
