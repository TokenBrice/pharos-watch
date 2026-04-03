// worker/src/cron/sync-yield-data.ts
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { getCirculatingRaw } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getCache, setCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";
import { ON_CHAIN_RATE_CONFIGS } from "./yield-config";
import type { ChainRpcConfig } from "../lib/chain-registry";
import {
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  parseYieldSupplementalSourcesCache,
  serializeDeterministicOnChainHealthState,
} from "./yield-sync/cache";
import {
  fetchOnChainRates,
  loadDlStablecoinPools,
  loadRiskFreeRateRegistry,
} from "./yield-sync/sources";
import { toYieldBenchmarkRegistry } from "./yield-sync/benchmarks";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  loadYieldHistorySnapshots,
  type YieldHistorySnapshotRow,
} from "./yield-sync/history";
import {
  evaluateYieldSources,
  buildHistoryKey,
  isLegacyDeterministicOnChainSourceKey,
  normalizePreviousBestSourceKey,
  shouldDegradeForRiskFreeRate,
} from "./yield-sync/evaluation";
import { buildYieldSourceProvenance } from "./yield-sync/provenance";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  persistEvaluatedYieldSources,
  readPreviousYieldRankingsCount,
  pruneYieldTables,
  validateYieldRankingsPayloadForPublish,
  writeYieldRankingsCache,
} from "./yield-sync/publication";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
const YIELD_SUPPLEMENTAL_CACHE_KEY = "yield:supplemental-sources:v1";
const DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY = "yield:onchain-health:v1";
const YIELD_SUPPLEMENTAL_MAX_AGE_SEC = 12 * 3600;
const DETERMINISTIC_ONCHAIN_COOLDOWN_THRESHOLD = 2;
const DETERMINISTIC_ONCHAIN_COOLDOWN_SEC = 6 * 3600;

interface YieldSupplementalCacheMeta {
  mode: "cache" | "stale-cache" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  sourceCount: number;
  fallbackMode: string | null;
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

function buildNextDeterministicOnChainHealthState(params: {
  deterministicConfigCount: number;
  previous: ReturnType<typeof getDefaultDeterministicOnChainHealthState>;
  startSec: number;
  onChainAttemptedCount: number;
  onChainRatesResolved: number;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  onChainSkippedDueToCooldown: boolean;
}) {
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
// -- Main sync function ------------------------------------------------------

export async function syncYieldData(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * DAY_SECONDS;
  const yieldCoins = ACTIVE_YIELD_BEARING_STABLECOINS;
  const yieldCoinIdSet = new Set(yieldCoins.map((coin) => coin.id));

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const { pools: dlPools, meta: dlPoolsMeta } = await loadDlStablecoinPools(db, signal);
  const { candidates: supplementalCandidates, meta: supplementalMeta } = await loadYieldSupplementalCandidates(
    db,
    startSec,
  );
  const onChainHealthCache = await getCache(db, DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY);
  const onChainHealthState = onChainHealthCache
    ? parseDeterministicOnChainHealthState(onChainHealthCache.value)
    : getDefaultDeterministicOnChainHealthState();
  const onChainCooldownActive =
    ON_CHAIN_RATE_CONFIGS.length > 0 &&
    onChainHealthState.cooldownUntil != null &&
    onChainHealthState.cooldownUntil > startSec;
  const onChainCooldownRemainingSec =
    onChainCooldownActive && onChainHealthState.cooldownUntil != null
      ? Math.max(0, onChainHealthState.cooldownUntil - startSec)
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
    : await fetchOnChainRates(signal, chainRpcs, etherscanApiKey);
  const {
    rates: onChainRates,
    failureBreakdown: onChainFailures,
    attemptedCount: onChainAttemptedCount = 0,
    allDeterministicFailed = false,
    explorerAttemptedCount: onChainExplorerAttemptedCount = 0,
    explorerResolvedCount: onChainExplorerResolvedCount = 0,
  } = onChainFetchResult;
  const riskFreeRates = await loadRiskFreeRateRegistry(db);
  const riskFreeRateMeta = riskFreeRates.USD;
  const riskFreeRate = riskFreeRateMeta.rate;
  const stablecoinSupplyById = new Map<string, number>();
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (stablecoinsCache?.value) {
    try {
      for (const [id, supplyUsd] of buildStablecoinSupplyMapFromCacheValue(stablecoinsCache.value)) {
        stablecoinSupplyById.set(id, supplyUsd);
      }
    } catch (error) {
      console.warn("[sync-yield-data] Failed to parse stablecoins cache for lending size gates:", error);
    }
  }

  const safetySnapshot = await computeSafetyScoresSnapshot(db, {
    includeNavTokens: true,
    outputMode: "map",
  });
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  const safetySnapshotDegraded =
    safetySnapshot.kind !== "ok" || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
      `(${(safetyCoverageRatio * 100).toFixed(1)}%)${safetySnapshot.reason ? ` reason=${safetySnapshot.reason}` : ""}`,
    );
  }

  const scoresObj: Record<string, { score: number; grade: string }> = {};
  for (const [id, val] of safetyScores) {
    scoresObj[id] = val;
  }
  if (!safetySnapshotDegraded) {
    await setCache(
      db,
      "report_card_cache",
      JSON.stringify({
        scores: scoresObj,
        updatedAt: startSec,
      }),
    );
  } else {
    console.warn("[sync-yield-data] Skipped report_card_cache write due to degraded safety snapshot");
  }

  const { resolved, tier1PrevRates } = await resolveYieldSources({
    db,
    startSec,
    sevenDaysAgoSec,
    dlPools,
    onChainRates,
    safetyScores,
    riskFreeRates,
    signal,
    chainRpcs,
    coingeckoApiKey,
    supplementalCandidates,
    stablecoinSupplyById,
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedYieldBearingIds = new Set(
    resolvedWithYield
      .filter((entry) => yieldCoinIdSet.has(entry.id))
      .map((entry) => entry.id),
  );
  const resolvedIds = [...new Set(resolvedWithYield.map((entry) => entry.id))];
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const sourceHistory = new Map<string, YieldHistorySnapshotRow[]>();
  const onChainCompatibilityHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyDeterministicOnChainHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const prevTvlBySource = new Map<string, number | null>();
  const legacyPrevTvlById = new Map<string, number | null>();
  const prevBestSourceKeyByCoin = new Map<string, string>();

  if (resolvedIds.length > 0) {
    const {
      historyRows,
      prevTvlRows,
      prevBestRows,
    } = await loadYieldHistorySnapshots(db, resolvedIds, startSec, sevenDaysAgoSec);

    for (const row of historyRows) {
      const sourceKey = row.source_key ?? "legacy-best";
      const normalizedRow = { ...row, source_key: sourceKey };
      if (sourceKey === "legacy-best") {
        const list = legacyHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        legacyHistoryById.set(row.stablecoin_id, list);
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        const list = sourceHistory.get(key) ?? [];
        list.push(normalizedRow);
        sourceHistory.set(key, list);
      }

      if (row.data_source === "onchain" && row.exchange_rate != null) {
        const list = onChainCompatibilityHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        onChainCompatibilityHistoryById.set(row.stablecoin_id, list);
      }

      if (isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, sourceKey)) {
        const list = legacyDeterministicOnChainHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        legacyDeterministicOnChainHistoryById.set(row.stablecoin_id, list);
      }
    }

    for (const row of prevTvlRows) {
      const sourceKey = row.source_key ?? "legacy-best";
      if (sourceKey === "legacy-best") {
        if (!legacyPrevTvlById.has(row.stablecoin_id)) {
          legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
        }
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        if (!prevTvlBySource.has(key)) {
          prevTvlBySource.set(key, row.source_tvl_usd ?? null);
        }
      }
    }

    for (const row of prevBestRows) {
      if (!prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
        prevBestSourceKeyByCoin.set(
          row.stablecoin_id,
          normalizePreviousBestSourceKey(row),
        );
      }
    }
  }

  const {
    evaluatedSources,
    bestSourceKeyByCoin,
    defaultSafetyIds,
    rowsRejected,
    divergenceFlags,
    sourceSwitches,
    medianApy,
  } = evaluateYieldSources({
    resolved: resolvedWithYield,
    startSec,
    sevenDaysAgoSec,
    safetyScores,
    riskFreeRates,
    tier1PrevRates,
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
  });

  const deterministicSourceIds = Array.from(
    new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId)),
  );
  const nonOnchainEvaluatedIds = new Set(
    evaluatedSources
      .filter((source) => source.dataSource !== "onchain")
      .map((source) => source.id),
  );
  const onChainAlternativeCoverageMissingIds = deterministicSourceIds.filter(
    (id) => !nonOnchainEvaluatedIds.has(id),
  );
  const maskedAllDeterministicFailure =
    allDeterministicFailed &&
    deterministicSourceIds.length > 0 &&
    onChainAlternativeCoverageMissingIds.length === 0;
  const nextOnChainHealthState = buildNextDeterministicOnChainHealthState({
    deterministicConfigCount: deterministicSourceIds.length,
    previous: onChainHealthState,
    startSec,
    onChainAttemptedCount,
    onChainRatesResolved: onChainRates.size,
    allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown,
  });
  const onChainCooldownTriggered =
    !onChainCooldownActive &&
    nextOnChainHealthState.cooldownUntil != null &&
    nextOnChainHealthState.cooldownUntil > startSec;
  await setCacheIfNewer(
    db,
    DETERMINISTIC_ONCHAIN_HEALTH_CACHE_KEY,
    serializeDeterministicOnChainHealthState(nextOnChainHealthState),
    startSec,
  );

  {
    const nativeApyByCoin = new Map<string, number>();
    const lendingApyByCoin = new Map<string, number>();
    for (const source of evaluatedSources) {
      if (source.yieldType === "lending-opportunity") {
        lendingApyByCoin.set(source.id, source.currentApy);
      } else {
        nativeApyByCoin.set(source.id, source.currentApy);
      }
    }
    for (const [coinId, nativeApy] of nativeApyByCoin) {
      const lendingApy = lendingApyByCoin.get(coinId);
      if (lendingApy != null && nativeApy > 0 && lendingApy > 0) {
        const divergence = Math.abs(nativeApy - lendingApy) / Math.max(Math.abs(nativeApy), Math.abs(lendingApy), 1e-9);
        if (divergence > 0.35) {
          console.warn(
            `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
          );
        }
      }
    }
  }

  // Coverage regression guard: skip persistence if yield coverage drops below 60%
  // Only applies when there are enough tracked coins to make the ratio meaningful.
  const MIN_YIELD_COVERAGE_RATIO = 0.6;
  const MIN_YIELD_COINS_FOR_GUARD = 10;
  const yieldCoverageRatio = yieldCoins.length > 0 ? resolvedYieldBearingIds.size / yieldCoins.length : 1;
  if (yieldCoins.length >= MIN_YIELD_COINS_FOR_GUARD && yieldCoverageRatio < MIN_YIELD_COVERAGE_RATIO) {
    console.error(
      `[sync-yield-data] Yield coverage regression: ${resolvedYieldBearingIds.size}/${yieldCoins.length} ` +
      `(${(yieldCoverageRatio * 100).toFixed(1)}%) — skipping persistence`,
    );
    return {
      status: "degraded" as const,
      itemCount: resolvedYieldBearingIds.size,
      metadata: JSON.stringify({
        reason: "coverage-regression",
        coverage: yieldCoverageRatio,
        resolvedCount: resolvedYieldBearingIds.size,
        totalCount: yieldCoins.length,
      }),
    };
  }

  const safetySnapshotMeta = {
    kind: safetySnapshot.kind,
    coverageRatio: Number(safetyCoverageRatio.toFixed(4)),
    coveredCount: safetySnapshot.coveredCount,
    trackedCount: safetySnapshot.trackedCount,
    reason: safetySnapshot.reason ?? null,
  } as const;

  const previewRankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of evaluatedSources) {
    previewRankingProvenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: bestSourceKeyByCoin.get(source.id) === source.sourceKey,
        evaluatedSources,
        startSec,
        dlPoolsMeta,
      }),
    );
  }

  const previewRankingsPayload = buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources,
    bestSourceKeyByCoin,
    rankingProvenanceByKey: previewRankingProvenanceByKey,
    riskFreeRate,
    riskFreeRateMeta,
    riskFreeRateRegistry: toYieldBenchmarkRegistry(riskFreeRates),
    dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    medianApy,
    startSec,
  });

  const previousRankingsState = await readPreviousYieldRankingsCount(db, { allowedIds: yieldCoinIdSet });
  if (previousRankingsState.malformed) {
    return {
      status: "degraded",
      itemCount: previewRankingsPayload.rankings.filter((ranking) => yieldCoinIdSet.has(ranking.id)).length,
      metadata: JSON.stringify({
        reason: "previous-yield-rankings-cache-invalid",
      }),
    };
  }
  const previousPublishedYieldBearingCount = previousRankingsState.count;
  const currentPublishedYieldBearingCount = previewRankingsPayload.rankings
    .filter((ranking) => yieldCoinIdSet.has(ranking.id))
    .length;
  if (
    previousPublishedYieldBearingCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedYieldBearingCount < Math.ceil(previousPublishedYieldBearingCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      status: "degraded",
      itemCount: currentPublishedYieldBearingCount,
      metadata: JSON.stringify({
        reason: "published-yield-coverage-regression",
        previousPublishedYieldBearingCount,
        currentPublishedYieldBearingCount,
      }),
    };
  }

  const degradationReasons: string[] = [];
  if (safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (safetySnapshot.reason) {
      degradationReasons.push(`safety-snapshot:${safetySnapshot.reason}`);
    }
  }
  if (shouldDegradeForRiskFreeRate(riskFreeRateMeta)) {
    degradationReasons.push(`risk-free-rate:${riskFreeRateMeta.fallbackMode}`);
  }
  if (dlPoolsMeta.mode === "unavailable" || dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${dlPoolsMeta.fallbackMode ?? dlPoolsMeta.mode}`);
  }
  if (allDeterministicFailed) {
    if (maskedAllDeterministicFailure) {
      console.warn(
        "[sync-yield-data] Deterministic on-chain lane failed, but all configured coins retained non-onchain yield coverage",
      );
    } else {
      degradationReasons.push("onchain-rates:all-deterministic-failed");
    }
  }
  if (onChainSkippedDueToCooldown && onChainAlternativeCoverageMissingIds.length > 0) {
    degradationReasons.push("onchain-rates:cooldown-coverage-gap");
  }

  const previewPublishability = await validateYieldRankingsPayloadForPublish(db, previewRankingsPayload);
  if (!previewPublishability.ok) {
    degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
    return {
      status: "degraded" as const,
      itemCount: resolvedIds.length,
      metadata: JSON.stringify({
        reason: "yield-rankings-preflight-failed",
        publishFailure: previewPublishability.reason ?? "schema-validation-failed",
        validationFailures: previewPublishability.validationFailures,
        rowsRejected,
        divergenceFlags,
        sourceSwitches,
      }),
    };
  }

  const {
    updatedCount,
  } = await persistEvaluatedYieldSources(db, {
    evaluatedSources,
    bestSourceKeyByCoin,
    startSec,
    medianApy,
    dlPoolsMeta,
  });

  const cacheWrite = await writeYieldRankingsCache(db, previewRankingsPayload);
  if (!cacheWrite.ok) {
    degradationReasons.push(cacheWrite.reason ?? "schema-validation-failed");
  }
  const validationFailures = cacheWrite.validationFailures;

  const shouldRetainPreviousRows = degradationReasons.length > 0;
  await pruneYieldTables(db, startSec, {
    allowDestructiveCleanup: !shouldRetainPreviousRows,
  });

  console.log(`[sync-yield-data] Updated ${updatedCount} source rows (${yieldCoins.length} yield-bearing + auto-discovered)`);
  const status = degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsDropped: rowsRejected,
      rowsRejected,
      divergenceFlags,
      sourceSwitches,
      defaultSafetyCoinCount: defaultSafetyIds.size,
      sourceCoverage: {
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
        safetyCoverageRatio: Number(safetyCoverageRatio.toFixed(4)),
        resolvedYieldBearingCount: resolvedYieldBearingIds.size,
        expectedYieldBearingCount: yieldCoins.length,
        publishedYieldBearingCount: currentPublishedYieldBearingCount,
        previousPublishedYieldBearingCount,
        dlPoolCount: dlPoolsMeta.poolCount,
        supplementalSourceMode: supplementalMeta.mode,
        supplementalSourceUpdatedAt: supplementalMeta.updatedAt,
        supplementalSourceAgeSeconds: supplementalMeta.ageSeconds,
        supplementalSourceCount: supplementalMeta.sourceCount,
        onChainRatesResolved: onChainRates.size,
        onChainRatesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        onChainAttempted: onChainAttemptedCount,
        onChainAllDeterministicFailed: allDeterministicFailed,
        onChainExplorerAttempted: onChainExplorerAttemptedCount,
        onChainExplorerResolved: onChainExplorerResolvedCount,
        onChainFailureMaskedByAlternativeCoverage: maskedAllDeterministicFailure,
        onChainAlternativeCoverageMissingIds,
        onChainFailures: onChainFailures,
        onChainSkippedDueToCooldown,
        onChainCooldownActive,
        onChainCooldownTriggered,
        onChainCooldownUntil: nextOnChainHealthState.cooldownUntil,
        onChainCooldownRemainingSec,
        onChainConsecutiveAllFailRuns: nextOnChainHealthState.consecutiveAllFailRuns,
        onChainConsecutiveMaskedAllFailRuns: nextOnChainHealthState.consecutiveMaskedAllFailRuns,
      },
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !cacheWrite.ok,
    }),
  };
}
