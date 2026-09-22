/**
 * Monthly yield coverage audit.
 *
 * Identifies DeFiLlama stablecoin pools that are not covered by Pharos yield
 * tracking — either because the pool UUID is not in YIELD_POOL_MAP, or because
 * the protocol is not in LENDING_PROTOCOL_ALLOWLIST — and persists a summary
 * report to the cache for operator review.
 */

import { logCronEvent, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { toErrorMessage } from "@shared/lib/error-utils";
import { readCachedJson } from "../lib/api-cache-read";
import { getCache, setCache } from "../lib/db-cache";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { reportCronProgress } from "../lib/cron-progress";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { loadDlStablecoinPools } from "./yield-sync/sources";
import {
  AUTO_LENDING_POOL_MAP,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  LENDING_PROTOCOL_ALLOWLIST,
  YIELD_ADAPTER_MANIFEST,
  YIELD_POOL_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "../lib/yield-config/yield-config";
import { computeSafetyScoresSnapshot, type PublishedSafetyScoresResultMap } from "../lib/safety-scores";
import { buildStablecoinSupplyMapFromCacheValue } from "./yield-sync/supply-map";
import type { YieldAdapterLifecycleEntry } from "../lib/yield-config/yield-config-registry";
import { YIELD_ADAPTER_LIFECYCLE } from "../lib/yield-config/yield-config-rate-sources";
import { probeQuarantinedDeterministicAdapters } from "./yield-coverage-audit-quarantine";
import {
  applyYieldCoverageReviewDispositions,
  type YieldCoverageReviewDispositionSummary,
} from "./yield-coverage-review-dispositions";
import { findStaleVenueRiskScores } from "@shared/lib/yield-source-risk-registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import type { YieldAdapterLifecycle } from "@shared/types/yield";
import {
  buildCoverageAuditOperatorQueue,
  buildProtocolCategoryLookupFromCachePayload,
  identifyCoverageGaps,
  identifyDeadCuratedPins,
  identifyStaleAutoLendingOverrides,
  isHighConfidenceProtocolCategory,
  protocolRowsFromCachePayload,
  type CoverageAuditOperatorQueue,
  type PublishedYieldVenueRow,
} from "./yield-coverage-audit/detectors";

const OPERATOR_QUEUE_ITEM_LIMIT = 20;
const REPORT_HEADLINE_ITEM_LIMIT = 50;
const LIFECYCLE_BUCKET_LIMIT = 100;
const YIELD_COVERAGE_AUDIT_PROGRESS_STAGES = 6;

export interface ProtocolCategoryAuditMeta {
  cacheKey: typeof CIRCUIT_SOURCE.DL_PROTOCOLS;
  status: "ok" | "missing" | "malformed";
  protocolCount: number;
  categorizedProtocolCount: number;
  highConfidenceCategoryCount: number;
}

async function loadProtocolCategoryLookup(db: D1Database): Promise<{
  categoriesByProject: Map<string, string>;
  meta: ProtocolCategoryAuditMeta;
}> {
  const cached = await getCache(db, CIRCUIT_SOURCE.DL_PROTOCOLS);
  const parsed = readCachedJson<unknown>("yield-coverage-audit", CIRCUIT_SOURCE.DL_PROTOCOLS, cached);

  if (parsed.status !== "ok") {
    return {
      categoriesByProject: new Map(),
      meta: {
        cacheKey: CIRCUIT_SOURCE.DL_PROTOCOLS,
        status: parsed.status,
        protocolCount: 0,
        categorizedProtocolCount: 0,
        highConfidenceCategoryCount: 0,
      },
    };
  }

  const protocolRows = protocolRowsFromCachePayload(parsed.data);
  const categoriesByProject = buildProtocolCategoryLookupFromCachePayload(parsed.data);
  return {
    categoriesByProject,
    meta: {
      cacheKey: CIRCUIT_SOURCE.DL_PROTOCOLS,
      status: "ok",
      protocolCount: protocolRows.length,
      categorizedProtocolCount: categoriesByProject.size,
      highConfidenceCategoryCount: [...categoriesByProject.values()]
        .filter(isHighConfidenceProtocolCategory).length,
    },
  };
}

export interface LifecycleAdapterBucketItem {
  stablecoinId: string;
  code: string;
  since: string;
  nextReviewAt?: string;
  note?: string;
}

export interface LifecycleSummary {
  active: number;
  quarantined: number;
  intentionalGap: number;
  experimental: number;
}

export interface LifecycleAuditBuckets {
  lifecycleSummary: LifecycleSummary;
  quarantinedAdapters: LifecycleAdapterBucketItem[];
  intentionalGaps: LifecycleAdapterBucketItem[];
  /**
   * Quarantined or intentionally uncovered adapters whose registry
   * `nextReviewAt` has arrived. The registry date is advisory, so the audit is
   * the only place a past-due lifecycle review becomes visible.
   */
  reviewDueAdapters: LifecycleAdapterBucketItem[];
}

function lifecycleBucketKey(lifecycle: YieldAdapterLifecycle): keyof LifecycleSummary {
  switch (lifecycle) {
    case "active":
      return "active";
    case "quarantined":
      return "quarantined";
    case "intentional-gap":
      return "intentionalGap";
    case "experimental":
      return "experimental";
  }
}

function isLifecycleReviewDue(nextReviewAt: string | undefined, nowMs: number): boolean {
  if (!nextReviewAt) return false;
  // Registry dates are calendar days (`YYYY-MM-DD`); a review is due once that
  // UTC day starts. Full ISO timestamps are parsed as-is.
  const dueMs = Date.parse(nextReviewAt.length === 10 ? `${nextReviewAt}T00:00:00Z` : nextReviewAt);
  return Number.isFinite(dueMs) && dueMs <= nowMs;
}

/**
 * Pure function: given the set of yield-bearing stablecoin IDs and the typed
 * adapter lifecycle registry, returns a summary count and bounded actionable
 * lists of quarantined adapters, intentional gaps, and past-due reviews.
 */
export function summarizeAdapterLifecycle(
  yieldBearingIds: readonly string[],
  lifecycleRegistry: Record<string, YieldAdapterLifecycleEntry> = YIELD_ADAPTER_LIFECYCLE,
  nowMs: number = Date.now(),
): LifecycleAuditBuckets {
  const summary: LifecycleSummary = {
    active: 0,
    quarantined: 0,
    intentionalGap: 0,
    experimental: 0,
  };
  const quarantinedAdapters: LifecycleAdapterBucketItem[] = [];
  const intentionalGaps: LifecycleAdapterBucketItem[] = [];
  const reviewDueAdapters: LifecycleAdapterBucketItem[] = [];

  for (const stablecoinId of yieldBearingIds) {
    const entry = lifecycleRegistry[stablecoinId] ?? { lifecycle: "active" };
    summary[lifecycleBucketKey(entry.lifecycle)] += 1;

    if (entry.lifecycle === "quarantined" && entry.reason) {
      const item: LifecycleAdapterBucketItem = {
        stablecoinId,
        code: entry.reason.code,
        since: entry.reason.since,
        nextReviewAt: entry.reason.nextReviewAt,
        note: entry.reason.note,
      };
      quarantinedAdapters.push(item);
      if (isLifecycleReviewDue(entry.reason.nextReviewAt, nowMs)) reviewDueAdapters.push(item);
    } else if (entry.lifecycle === "intentional-gap" && entry.reason) {
      const item: LifecycleAdapterBucketItem = {
        stablecoinId,
        code: entry.reason.code,
        since: entry.reason.since,
        nextReviewAt: entry.reason.nextReviewAt,
        note: entry.reason.note,
      };
      intentionalGaps.push(item);
      if (isLifecycleReviewDue(entry.reason.nextReviewAt, nowMs)) reviewDueAdapters.push(item);
    }
  }

  quarantinedAdapters.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
  intentionalGaps.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
  reviewDueAdapters.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));

  return {
    lifecycleSummary: summary,
    quarantinedAdapters: quarantinedAdapters.slice(0, LIFECYCLE_BUCKET_LIMIT),
    intentionalGaps: intentionalGaps.slice(0, LIFECYCLE_BUCKET_LIMIT),
    reviewDueAdapters: reviewDueAdapters.slice(0, LIFECYCLE_BUCKET_LIMIT),
  };
}

async function loadStablecoinSupplyMapForAudit(db: D1Database): Promise<Map<string, number>> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache?.value) return new Map();

  try {
    return buildStablecoinSupplyMapFromCacheValue(stablecoinsCache.value);
  } catch (error) {
    await logCronEvent(db, {
      job: "yield-coverage-audit",
      eventType: "stablecoins-cache-parse-failed",
      severity: "warning",
      message: "Failed to parse stablecoins cache for lending size gates; falling back to absolute TVL floors.",
      metadata: {
        error: toErrorMessage(error),
      },
    });
    return new Map();
  }
}

async function loadSafetyScoresForAudit(db: D1Database): Promise<PublishedSafetyScoresResultMap> {
  return computeSafetyScoresSnapshot(db);
}

/**
 * Async cron function: loads DL pools from cache, loads the existing yield
 * coverage state from the DB, computes gaps, and persists a summary report.
 */
export async function runYieldCoverageAudit(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const reportAuditProgress = async (
    stage: string,
    message: string,
    itemsDone: number,
    metadata: Record<string, unknown> = {},
  ) => {
    await reportCronProgress(reportProgress, {
      stage,
      message,
      providerFamily: "yield-coverage-audit",
      itemsDone,
      itemsTotal: YIELD_COVERAGE_AUDIT_PROGRESS_STAGES,
      metadata,
    });
  };

  // Load DL stablecoin pools (uses cache written by dex-liquidity sync)
  await reportAuditProgress("pool-load", "Loading DeFiLlama stablecoin yield pools", 0, {
    providerFamilies: ["defillama-yields"],
  });
  const { pools: dlPools, meta: poolMeta } = await loadDlStablecoinPools(db, signal);
  await reportAuditProgress("pool-load", "Loaded DeFiLlama stablecoin yield pools", 1, {
    providerFamilies: ["defillama-yields"],
    countTotals: {
      dlPools: dlPools.length,
    },
    poolMeta,
  });

  await reportAuditProgress("protocol-category-load", "Loading DeFiLlama protocol categories", 1, {
    providerFamilies: ["defillama-protocols"],
    cacheKey: CIRCUIT_SOURCE.DL_PROTOCOLS,
  });
  const protocolCategoryLookup = await loadProtocolCategoryLookup(db);
  await reportAuditProgress("protocol-category-load", "Loaded DeFiLlama protocol categories", 2, {
    providerFamilies: ["defillama-protocols"],
    cacheKey: protocolCategoryLookup.meta.cacheKey,
    protocolCategoryStatus: protocolCategoryLookup.meta.status,
    countTotals: {
      protocols: protocolCategoryLookup.meta.protocolCount,
      categorizedProtocols: protocolCategoryLookup.meta.categorizedProtocolCount,
      highConfidenceCategories: protocolCategoryLookup.meta.highConfidenceCategoryCount,
    },
  });

  if (dlPools.length === 0) {
    await reportAuditProgress("complete", "Yield coverage audit completed without DeFiLlama pools", 6, {
      reason: "no-dl-pools",
      poolMeta,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "no-dl-pools", poolMeta },
    });
  }

  // Track the exact DL pool IDs already covered by static native mappings,
  // explicit auto-discovery overrides, and curated exact-pool overrides.
  const coveredPools = new Set([
    ...Object.values(YIELD_POOL_MAP),
    ...Object.values(AUTO_LENDING_POOL_MAP),
    ...Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP).flat().map((config) => config.poolId),
    ...Object.values(YIELD_WEIGHTED_POOL_GROUPS).flatMap((config) => config.poolIds),
  ]);
  const rankingsCache = readCachedJson<{
    rankings?: Array<{
      id?: string;
      sourceTvlUsd?: number | null;
      sourceRisk?: { venueProtocol?: string | null } | null;
      provenance?: { sourceKey?: string | null } | null;
      altSources?: Array<{
        sourceKey?: string | null;
        sourceTvlUsd?: number | null;
        sourceRisk?: { venueProtocol?: string | null } | null;
      }>;
    }>;
  }>(
    "yield-coverage-audit",
    "yield-rankings",
    await getCache(db, "yield-rankings"),
  );
  if (rankingsCache.status !== "ok") {
    const reason = `yield-rankings-cache-${rankingsCache.status}`;
    await reportAuditProgress("complete", "Yield coverage audit deferred pending a readable rankings cache", 6, {
      reason,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason },
    });
  }
  const publishedRankingRows = rankingsCache.data.rankings ?? [];
  const publishedYieldIds = new Set(
    publishedRankingRows
      .map((ranking) => ranking.id)
      .filter((id): id is string => typeof id === "string"),
  );
  // Selected and retained alternate rows both publish venue evidence, and both
  // carry the registry gap A10 has to queue.
  const publishedVenueRows: PublishedYieldVenueRow[] = publishedRankingRows.flatMap((ranking) => {
    const stablecoinId = ranking.id;
    if (typeof stablecoinId !== "string") return [];
    return [
      {
        stablecoinId,
        venueProtocol: ranking.sourceRisk?.venueProtocol ?? null,
        sourceKey: ranking.provenance?.sourceKey ?? null,
        sourceTvlUsd: ranking.sourceTvlUsd ?? null,
      },
      ...(ranking.altSources ?? []).map((alternate) => ({
        stablecoinId,
        venueProtocol: alternate.sourceRisk?.venueProtocol ?? null,
        sourceKey: alternate.sourceKey ?? null,
        sourceTvlUsd: alternate.sourceTvlUsd ?? null,
      })),
    ];
  });
  const gaps = identifyCoverageGaps(
    dlPools,
    coveredPools,
    LENDING_PROTOCOL_ALLOWLIST,
    protocolCategoryLookup.categoriesByProject,
    { publishedVenueRows, publishedStablecoinIds: publishedYieldIds },
  );
  await reportAuditProgress("safety-supply-load", "Loading stablecoin supply and safety snapshots", 2, {
    providerFamilies: ["stablecoins-cache", "safety-scores"],
  });
  const stablecoinSupplyById = await loadStablecoinSupplyMapForAudit(db);
  const safetySnapshot = await loadSafetyScoresForAudit(db);
  await reportAuditProgress("safety-supply-load", "Loaded stablecoin supply and safety snapshots", 3, {
    providerFamilies: ["stablecoins-cache", "safety-scores"],
    countTotals: {
      stablecoinSupplyRows: stablecoinSupplyById.size,
      safetyScoresComputed: safetySnapshot.coveredCount,
      safetyScoresExpected: safetySnapshot.trackedCount,
    },
    safetySnapshotKind: safetySnapshot.kind,
    safetySnapshotReason: safetySnapshot.reason ?? null,
    safetySnapshotSource: safetySnapshot.source,
    safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
  });
  if (safetySnapshot.kind !== "ok" || safetySnapshot.safetyScoreIdentity == null) {
    const reason =
      safetySnapshot.reason ??
      "safety-score-v9-publication:identity-missing";
    await reportAuditProgress("complete", "Yield coverage audit deferred pending an identified safety snapshot", 6, {
      reason,
      safetySnapshotSource: safetySnapshot.source,
      safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: `safety-snapshot-unavailable:${reason}`,
        safetySnapshotSource: safetySnapshot.source,
        safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
      },
    });
  }
  const staleAutoLendingOverrides = identifyStaleAutoLendingOverrides(dlPools, {
    stablecoinSupplyById,
    safetyScores: safetySnapshot.scores,
  });
  const deadCuratedPins = identifyDeadCuratedPins(dlPools, {
    publishedStablecoinIds: publishedYieldIds,
  });
  const manifestById = new Map(YIELD_ADAPTER_MANIFEST.map((entry) => [entry.stablecoinId, entry]));
  const manifestMissingIds = ACTIVE_YIELD_BEARING_STABLECOINS
    .filter((coin) => !manifestById.has(coin.id))
    .map((coin) => coin.id);
  const intentionalGapIds = YIELD_ADAPTER_MANIFEST
    .filter((entry) => entry.status === "intentional-gap")
    .map((entry) => entry.stablecoinId);
  const yieldBearingIds = new Set(ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id));
  const explicitPoolOverrides = Object.entries(EXPLICIT_YIELD_SOURCE_POOL_MAP).flatMap(
    ([stablecoinId, configs]) => configs.map((config) => ({
      stablecoinId,
      poolId: config.poolId,
      yieldType: config.yieldType,
      yieldSource: config.yieldSource,
      expectedProject: config.expectedProject ?? null,
      expectedChain: config.expectedChain ?? null,
    })),
  );
  const exactPoolOverrideYieldBearingIds = [...new Set(
    explicitPoolOverrides
      .filter((entry) => yieldBearingIds.has(entry.stablecoinId))
      .map((entry) => entry.stablecoinId),
  )].sort();
  const exactPoolOverrideNonYieldBearingOpportunityIds = [...new Set(
    explicitPoolOverrides
      .filter((entry) => !yieldBearingIds.has(entry.stablecoinId))
      .map((entry) => entry.stablecoinId),
  )].sort();

  const yieldBearingMissingFromRankings = ACTIVE_YIELD_BEARING_STABLECOINS
    .filter((coin) => {
      const manifestEntry = manifestById.get(coin.id);
      return manifestEntry?.status !== "intentional-gap" && !publishedYieldIds.has(coin.id);
    })
    .map((coin) => coin.id);
  const nowMs = Date.now();
  const lifecycleBuckets = summarizeAdapterLifecycle(
    ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id),
    YIELD_ADAPTER_LIFECYCLE,
    nowMs,
  );
  await reportAuditProgress("quarantine-probe", "Probing quarantined deterministic yield adapters", 3, {
    providerFamilies: ["on-chain-rates"],
    countTotals: {
      quarantinedAdapters: lifecycleBuckets.quarantinedAdapters.length,
    },
  });
  const quarantineProbe = await probeQuarantinedDeterministicAdapters({
    quarantinedAdapters: lifecycleBuckets.quarantinedAdapters,
    chainRpcs,
    signal,
  });
  await reportAuditProgress("quarantine-probe", "Completed quarantined deterministic adapter probe", 4, {
    providerFamilies: ["on-chain-rates"],
    countTotals: {
      quarantinedAdapters: lifecycleBuckets.quarantinedAdapters.length,
      quarantineProbeConfigured: quarantineProbe.summary.configuredProbeCount,
      quarantineProbeAttempted: quarantineProbe.summary.attemptedCount,
      quarantineReadyToRestore: quarantineProbe.readyToRestore.length,
    },
    quarantineProbeSummary: quarantineProbe.summary,
  });
  const staleVenueRiskScores = findStaleVenueRiskScores(nowMs);
  const candidateOperatorQueue = buildCoverageAuditOperatorQueue({
    gaps,
    manifestMissingIds,
    yieldBearingMissingFromRankings,
    staleAutoLendingOverrides,
    deadCuratedPins,
    quarantineReadyToRestore: quarantineProbe.readyToRestore,
    staleVenueRiskScores,
  });

  const reportedAt = Math.floor(nowMs / 1000);
  const {
    queue: operatorQueue,
    summary: operatorReviewSummary,
  }: {
    queue: CoverageAuditOperatorQueue & { persistence: "durable" };
    summary: YieldCoverageReviewDispositionSummary;
  } = await applyYieldCoverageReviewDispositions(db, candidateOperatorQueue, {
    nowSec: reportedAt,
    publishedItemLimit: OPERATOR_QUEUE_ITEM_LIMIT,
  });
  // C8: the admin panel can only render a bounded slice of the queue, so the
  // payload carries the composition of the durable queue plus the two reasons
  // an item is missing from it. candidateItemCount === sum(byKind) +
  // truncatedItemCount + suppressedItemCount.
  const queueByKind: Record<string, number> = {};
  for (const item of [...operatorQueue.headlineGaps, ...operatorQueue.recommendationCandidates]) {
    queueByKind[item.kind] = (queueByKind[item.kind] ?? 0) + 1;
  }
  const queueTotals = {
    byKind: queueByKind,
    suppressedItemCount: operatorReviewSummary.suppressedItemCount,
    truncated: operatorReviewSummary.truncatedItemCount > 0,
  };
  // Count fields shared between the persisted report payload and the CronResult
  // metadata. The two payloads otherwise diverge deliberately.
  const auditCounts = {
    totalDlPools: dlPools.length,
    coveredPoolCount: coveredPools.size,
    manifestYieldBearingCount: YIELD_ADAPTER_MANIFEST.length,
    unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
    missingProtocolCount: gaps.missingProtocols.length,
    protocolRecommendationCount: gaps.protocolRecommendations.length,
    nativeExactPoolRecommendationCount: gaps.nativeExactPoolRecommendations.length,
    sourceFamilyAdapterRecommendationCount: gaps.sourceFamilyAdapterRecommendations.length,
    lendingAllowlistRecommendationCount: gaps.lendingAllowlistRecommendations.length,
    venueRiskConfigMissingCount: gaps.venueRiskConfigMissing.length,
    staleAutoLendingOverrideCount: staleAutoLendingOverrides.length,
    deadCuratedPinCount: deadCuratedPins.length,
    lifecycleReviewDueCount: lifecycleBuckets.reviewDueAdapters.length,
    exactPoolOverrideCount: explicitPoolOverrides.length,
    exactPoolOverrideNonYieldBearingOpportunityCount: exactPoolOverrideNonYieldBearingOpportunityIds.length,
    staleVenueRiskScoreCount: staleVenueRiskScores.length,
  };
  const report = {
    reportedAt,
    ...auditCounts,
    manifestMissingIds,
    intentionalGapIds,
    yieldBearingMissingFromRankings,
    exactPoolOverrideYieldBearingCount: exactPoolOverrideYieldBearingIds.length,
    exactPoolOverrideYieldBearingIds,
    exactPoolOverrideNonYieldBearingOpportunityIds,
    exactPoolOverrides: explicitPoolOverrides.slice(0, REPORT_HEADLINE_ITEM_LIMIT),
    unmatchedHighTvlPools: gaps.unmatchedHighTvlPools.slice(0, REPORT_HEADLINE_ITEM_LIMIT),
    missingProtocols: gaps.missingProtocols.slice(0, REPORT_HEADLINE_ITEM_LIMIT),
    protocolRecommendations: gaps.protocolRecommendations.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    nativeExactPoolRecommendations: gaps.nativeExactPoolRecommendations.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    sourceFamilyAdapterRecommendations: gaps.sourceFamilyAdapterRecommendations.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    lendingAllowlistRecommendations: gaps.lendingAllowlistRecommendations.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    venueRiskConfigMissing: gaps.venueRiskConfigMissing.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    staleAutoLendingOverrides: staleAutoLendingOverrides.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    staleVenueRiskScores: staleVenueRiskScores.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    operatorQueue,
    operatorReviewSummary,
    queueTotals,
    deadCuratedPins: deadCuratedPins.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    reviewDueAdapters: lifecycleBuckets.reviewDueAdapters,
    lifecycleSummary: lifecycleBuckets.lifecycleSummary,
    quarantinedAdapters: lifecycleBuckets.quarantinedAdapters,
    quarantineReadyToRestore: quarantineProbe.readyToRestore,
    quarantineProbeSummary: quarantineProbe.summary,
    intentionalGaps: lifecycleBuckets.intentionalGaps,
    protocolCategoryMeta: protocolCategoryLookup.meta,
    manifest: YIELD_ADAPTER_MANIFEST.map((entry) => ({
      stablecoinId: entry.stablecoinId,
      status: entry.status,
      strategyKinds: entry.strategies.map((strategy) => strategy.kind),
      strategyLabels: entry.strategies.map((strategy) => strategy.label),
    })),
    poolMeta,
    safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
  };

  await reportAuditProgress("cache-write", "Publishing yield coverage audit cache", 5, {
    cacheKey: "yield-coverage-audit",
    countTotals: {
      ...auditCounts,
      manifestMissing: manifestMissingIds.length,
      yieldBearingMissingFromRankings: yieldBearingMissingFromRankings.length,
      operatorHeadlineGaps: operatorQueue.headlineGaps.length,
      operatorRecommendationCandidates: operatorQueue.recommendationCandidates.length,
      operatorSuppressedItems: operatorQueue.suppressedItemCount,
    },
  });
  await setCache(db, "yield-coverage-audit", JSON.stringify(report));
  if (deadCuratedPins.length > 0) {
    await logCronEvent(db, {
      job: "yield-coverage-audit",
      eventType: "curated-pin-missing",
      severity: "warning",
      message: `${deadCuratedPins.length} curated yield pin(s) are absent from the DeFiLlama snapshot.`,
      metadata: {
        deadCuratedPinCount: deadCuratedPins.length,
        coverageOutageCount: deadCuratedPins.filter((pin) => pin.coverage === "coverage-outage").length,
        pins: deadCuratedPins.slice(0, REPORT_HEADLINE_ITEM_LIMIT).map((pin) => ({
          stablecoinId: pin.stablecoinId,
          registry: pin.registry,
          pin: pin.pin,
          coverage: pin.coverage,
        })),
      },
    });
  }
  if (lifecycleBuckets.reviewDueAdapters.length > 0) {
    await logCronEvent(db, {
      job: "yield-coverage-audit",
      eventType: "lifecycle-review-due",
      severity: "warning",
      message: `${lifecycleBuckets.reviewDueAdapters.length} adapter lifecycle review(s) are past due.`,
      metadata: {
        lifecycleReviewDueCount: lifecycleBuckets.reviewDueAdapters.length,
        reviewDue: lifecycleBuckets.reviewDueAdapters.map((adapter) => ({
          stablecoinId: adapter.stablecoinId,
          code: adapter.code,
          nextReviewAt: adapter.nextReviewAt ?? null,
        })),
      },
    });
  }
  await reportAuditProgress("complete", "Published yield coverage audit cache", 6, {
    cacheKey: "yield-coverage-audit",
    countTotals: {
      ...auditCounts,
      manifestMissing: manifestMissingIds.length,
      yieldBearingMissingFromRankings: yieldBearingMissingFromRankings.length,
      operatorHeadlineGaps: operatorQueue.headlineGaps.length,
      operatorRecommendationCandidates: operatorQueue.recommendationCandidates.length,
      operatorSuppressedItems: operatorQueue.suppressedItemCount,
    },
  });

  const itemCount =
    gaps.unmatchedHighTvlPools.length +
    gaps.missingProtocols.length +
    gaps.nativeExactPoolRecommendations.length +
    gaps.sourceFamilyAdapterRecommendations.length +
    gaps.lendingAllowlistRecommendations.length +
    gaps.venueRiskConfigMissing.length +
    staleAutoLendingOverrides.length +
    deadCuratedPins.length +
    staleVenueRiskScores.length +
    quarantineProbe.readyToRestore.length +
    manifestMissingIds.length +
    yieldBearingMissingFromRankings.length;

  const protocolCategoryStatus = protocolCategoryLookup.meta.status;
  const degradedReason = protocolCategoryStatus === "ok" ? null : `protocol-category-cache-${protocolCategoryStatus}`;

  return createCronResult({
    status: protocolCategoryStatus === "ok" ? "ok" : "degraded",
    itemCount,
    metadata: {
      ...(degradedReason ? { reason: degradedReason } : {}),
      ...auditCounts,
      manifestMissingCount: manifestMissingIds.length,
      intentionalGapCount: intentionalGapIds.length,
      yieldBearingMissingFromRankingsCount: yieldBearingMissingFromRankings.length,
      operatorSuppressedItemCount: operatorQueue.suppressedItemCount,
      operatorQueueTruncated: queueTotals.truncated,
      protocolCategoryStatus,
      protocolCategoryCount: protocolCategoryLookup.meta.categorizedProtocolCount,
      quarantineReadyToRestoreCount: quarantineProbe.readyToRestore.length,
      quarantineProbeAttemptedCount: quarantineProbe.summary.attemptedCount,
      safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
    },
  });
}
