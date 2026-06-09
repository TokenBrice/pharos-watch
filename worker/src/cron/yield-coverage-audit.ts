/**
 * Monthly yield coverage audit.
 *
 * Identifies DeFiLlama stablecoin pools that are not covered by Pharos yield
 * tracking — either because the pool UUID is not in YIELD_POOL_MAP, or because
 * the protocol is not in LENDING_PROTOCOL_ALLOWLIST — and persists a summary
 * report to the cache for operator review.
 */

import type { CronResult } from "../lib/cron-logger";
import { readCachedJson } from "../lib/api-utils";
import { getCache, setCache } from "../lib/db-cache";
import { loadDlStablecoinPools } from "./yield-sync/sources";
import {
  AUTO_LENDING_POOL_MAP,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  LENDING_PROTOCOL_ALLOWLIST,
  YIELD_ADAPTER_MANIFEST,
  YIELD_POOL_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "./yield-config";
import {
  YIELD_ADAPTER_LIFECYCLE,
  type YieldAdapterLifecycleEntry,
} from "./yield-config-registry";
import type {
  YieldCoverageAuditQueueAction,
  YieldCoverageAuditQueueItem,
  YieldCoverageAuditQueueItemKind,
} from "@shared/types/status";
import type { YieldAdapterLifecycle } from "@shared/types/yield";
import type { DlPool } from "./yield-sync/types";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";

/** Minimum TVL (USD) for a pool to be flagged as an unmatched high-TVL pool. */
const HIGH_TVL_THRESHOLD_USD = 5_000_000;
const OPERATOR_QUEUE_ITEM_LIMIT = 20;
const OPERATOR_QUEUE_ACTIONS = [
  "accept",
  "dismiss",
  "intentional-gap",
  "watch",
] as const satisfies readonly YieldCoverageAuditQueueAction[];
const LIFECYCLE_BUCKET_LIMIT = 100;

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

/**
 * Pure function: given the set of yield-bearing stablecoin IDs and the typed
 * adapter lifecycle registry, returns a summary count and bounded actionable
 * lists of quarantined adapters and intentional gaps.
 */
export function summarizeAdapterLifecycle(
  yieldBearingIds: readonly string[],
  lifecycleRegistry: Record<string, YieldAdapterLifecycleEntry> = YIELD_ADAPTER_LIFECYCLE,
): LifecycleAuditBuckets {
  const summary: LifecycleSummary = {
    active: 0,
    quarantined: 0,
    intentionalGap: 0,
    experimental: 0,
  };
  const quarantinedAdapters: LifecycleAdapterBucketItem[] = [];
  const intentionalGaps: LifecycleAdapterBucketItem[] = [];

  for (const stablecoinId of yieldBearingIds) {
    const entry = lifecycleRegistry[stablecoinId] ?? { lifecycle: "active" };
    summary[lifecycleBucketKey(entry.lifecycle)] += 1;

    if (entry.lifecycle === "quarantined" && entry.reason) {
      quarantinedAdapters.push({
        stablecoinId,
        code: entry.reason.code,
        since: entry.reason.since,
        nextReviewAt: entry.reason.nextReviewAt,
        note: entry.reason.note,
      });
    } else if (entry.lifecycle === "intentional-gap" && entry.reason) {
      intentionalGaps.push({
        stablecoinId,
        code: entry.reason.code,
        since: entry.reason.since,
        nextReviewAt: entry.reason.nextReviewAt,
        note: entry.reason.note,
      });
    }
  }

  quarantinedAdapters.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
  intentionalGaps.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));

  return {
    lifecycleSummary: summary,
    quarantinedAdapters: quarantinedAdapters.slice(0, LIFECYCLE_BUCKET_LIMIT),
    intentionalGaps: intentionalGaps.slice(0, LIFECYCLE_BUCKET_LIMIT),
  };
}

export interface CoverageAuditOperatorQueue {
  persistence: "deferred";
  allowedActions: YieldCoverageAuditQueueAction[];
  headlineGaps: YieldCoverageAuditQueueItem[];
  recommendationCandidates: YieldCoverageAuditQueueItem[];
}

export interface CoverageGapPool {
  pool: string;
  project: string;
  symbol: string;
  chain: string;
  tvlUsd: number;
  apy: number;
}

export interface ProtocolRecommendation {
  project: string;
  poolCount: number;
  totalTvlUsd: number;
  recommendedTier: "high-confidence" | "review-needed";
  examplePools: string[];
}

export interface NativeExactPoolRecommendation extends CoverageGapPool {
  stablecoinIds: string[];
}

export interface CoverageGaps {
  /** Pools above the TVL threshold that are not in the covered set. */
  unmatchedHighTvlPools: CoverageGapPool[];
  /** Protocols with stablecoin pools but not in the lending allowlist. */
  missingProtocols: CoverageGapPool[];
  /** Actionable protocol recommendations based on TVL and pool count. */
  protocolRecommendations: ProtocolRecommendation[];
  /** High-TVL pools that look like native yield surfaces for tracked yield-bearing assets. */
  nativeExactPoolRecommendations: NativeExactPoolRecommendation[];
  /** High-TVL pools on protocol families that should be handled by source-family adapters. */
  sourceFamilyAdapterRecommendations: ProtocolRecommendation[];
  /** High-TVL non-allowlisted lending protocols that may warrant allowlist review. */
  lendingAllowlistRecommendations: ProtocolRecommendation[];
}

const SOURCE_FAMILY_ADAPTER_PROJECTS = new Set([
  "aave-v3",
  "aave-v4",
  "beefy",
  "compound-v3",
  "morpho-blue",
  "morpho-v1",
  "pendle",
  "yearn-finance",
]);

function buildCoverageGapPool(pool: DlPool): CoverageGapPool {
  return {
    pool: pool.pool,
    project: pool.project,
    symbol: pool.symbol,
    chain: pool.chain,
    tvlUsd: pool.tvlUsd,
    apy: pool.apy,
  };
}

function buildProtocolRecommendations(pools: CoverageGapPool[]): ProtocolRecommendation[] {
  const byProject = new Map<string, { pools: CoverageGapPool[]; tvl: number }>();
  for (const pool of pools) {
    const entry = byProject.get(pool.project) ?? { pools: [], tvl: 0 };
    entry.pools.push(pool);
    entry.tvl += pool.tvlUsd;
    byProject.set(pool.project, entry);
  }

  return [...byProject.entries()]
    .filter(([, v]) => v.tvl >= HIGH_TVL_THRESHOLD_USD)
    .map(([project, v]) => ({
      project,
      poolCount: v.pools.length,
      totalTvlUsd: v.tvl,
      recommendedTier: (v.tvl >= 10_000_000 && v.pools.length >= 3 ? "high-confidence" : "review-needed") as "high-confidence" | "review-needed",
      examplePools: v.pools.slice(0, 3).map((p) => p.pool),
    }))
    .sort((a, b) => b.totalTvlUsd - a.totalTvlUsd)
    .slice(0, 20);
}

function normalizeRecommendationSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function buildYieldBearingSymbolIndex(): Map<string, string[]> {
  const bySymbol = new Map<string, string[]>();
  for (const coin of ACTIVE_YIELD_BEARING_STABLECOINS) {
    const symbol = normalizeRecommendationSymbol(coin.symbol);
    const ids = bySymbol.get(symbol) ?? [];
    ids.push(coin.id);
    bySymbol.set(symbol, ids);
  }
  return bySymbol;
}

function queueId(kind: YieldCoverageAuditQueueItemKind, value: string): string {
  return `${kind}:${value.toLowerCase().replace(/[^a-z0-9_.:-]+/gu, "-")}`;
}

function poolTitle(pool: CoverageGapPool): string {
  return `${pool.symbol} on ${pool.project}`;
}

function buildPoolQueueItem(
  kind: Extract<YieldCoverageAuditQueueItemKind, "unmatched-high-tvl-pool" | "missing-protocol">,
  pool: CoverageGapPool,
  actionHint: YieldCoverageAuditQueueAction,
): YieldCoverageAuditQueueItem {
  return {
    id: queueId(kind, pool.pool),
    kind,
    title: poolTitle(pool),
    detail: `${pool.chain} pool ${pool.pool}`,
    actionHint,
    project: pool.project,
    pool: pool.pool,
    symbol: pool.symbol,
    chain: pool.chain,
    tvlUsd: pool.tvlUsd,
    apy: pool.apy,
  };
}

function buildProtocolQueueItem(
  kind: Extract<YieldCoverageAuditQueueItemKind, "source-family-adapter" | "lending-allowlist">,
  recommendation: ProtocolRecommendation,
): YieldCoverageAuditQueueItem {
  return {
    id: queueId(kind, recommendation.project),
    kind,
    title: recommendation.project,
    detail: `${recommendation.poolCount} pools across ${recommendation.examplePools.slice(0, 3).join(", ")}`,
    actionHint: recommendation.recommendedTier === "high-confidence" ? "accept" : "watch",
    project: recommendation.project,
    poolCount: recommendation.poolCount,
    totalTvlUsd: recommendation.totalTvlUsd,
    recommendedTier: recommendation.recommendedTier,
  };
}

export function buildCoverageAuditOperatorQueue({
  gaps,
  manifestMissingIds,
  yieldBearingMissingFromRankings,
}: {
  gaps: CoverageGaps;
  manifestMissingIds: string[];
  yieldBearingMissingFromRankings: string[];
}): CoverageAuditOperatorQueue {
  const headlineGaps: YieldCoverageAuditQueueItem[] = [
    ...manifestMissingIds.map((stablecoinId) => ({
      id: queueId("manifest-missing", stablecoinId),
      kind: "manifest-missing" as const,
      title: stablecoinId,
      detail: "Yield-bearing tracked asset has no adapter-manifest entry.",
      actionHint: "accept" as const,
      stablecoinIds: [stablecoinId],
    })),
    ...yieldBearingMissingFromRankings.map((stablecoinId) => ({
      id: queueId("ranking-missing", stablecoinId),
      kind: "ranking-missing" as const,
      title: stablecoinId,
      detail: "Manifest-covered yield-bearing asset is absent from the latest rankings cache.",
      actionHint: "watch" as const,
      stablecoinIds: [stablecoinId],
    })),
    ...gaps.unmatchedHighTvlPools.map((pool) => buildPoolQueueItem("unmatched-high-tvl-pool", pool, "watch")),
    ...gaps.missingProtocols.map((pool) => buildPoolQueueItem("missing-protocol", pool, "watch")),
  ];

  const recommendationCandidates: YieldCoverageAuditQueueItem[] = [
    ...gaps.nativeExactPoolRecommendations.map((pool) => ({
      id: queueId("native-exact-pool", pool.pool),
      kind: "native-exact-pool" as const,
      title: poolTitle(pool),
      detail: `${pool.chain} native pool for ${pool.stablecoinIds.join(", ")}`,
      actionHint: "accept" as const,
      stablecoinIds: pool.stablecoinIds,
      project: pool.project,
      pool: pool.pool,
      symbol: pool.symbol,
      chain: pool.chain,
      tvlUsd: pool.tvlUsd,
      apy: pool.apy,
    })),
    ...gaps.sourceFamilyAdapterRecommendations.map((recommendation) =>
      buildProtocolQueueItem("source-family-adapter", recommendation),
    ),
    ...gaps.lendingAllowlistRecommendations.map((recommendation) =>
      buildProtocolQueueItem("lending-allowlist", recommendation),
    ),
  ];

  return {
    persistence: "deferred",
    allowedActions: [...OPERATOR_QUEUE_ACTIONS],
    headlineGaps: headlineGaps.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
    recommendationCandidates: recommendationCandidates.slice(0, OPERATOR_QUEUE_ITEM_LIMIT),
  };
}

/**
 * Pure function: given a list of DL pools and the exact DL pool IDs already
 * covered by Pharos, returns coverage gaps.
 *
 * @param dlPools       - Full list of DL stablecoin pools.
 * @param coveredPools  - Set of exact covered DL pool UUIDs.
 */
export function identifyCoverageGaps(
  dlPools: DlPool[],
  coveredPools: Set<string>,
  supportedProtocols: Set<string> = LENDING_PROTOCOL_ALLOWLIST,
): CoverageGaps {
  const unmatchedHighTvlPools: CoverageGapPool[] = [];
  const missingProtocols: CoverageGapPool[] = [];
  const seenMissingProtocols = new Set<string>();
  const uncoveredStablecoinPools: CoverageGapPool[] = [];

  for (const pool of dlPools) {
    // Skip pools already covered
    if (coveredPools.has(pool.pool)) continue;

    const poolEntry = buildCoverageGapPool(pool);
    if (pool.exposure === "single" && pool.stablecoin) {
      uncoveredStablecoinPools.push(poolEntry);
    }

    // High-TVL gaps should focus on surfaces outside the already-supported
    // allowlisted protocol universe; otherwise the report is dominated by
    // pools the runtime already treats as covered opportunities.
    if (pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD && !supportedProtocols.has(pool.project)) {
      unmatchedHighTvlPools.push(poolEntry);
    }

    // Flag protocols not in the allowlist (once per project, any TVL)
    if (
      !supportedProtocols.has(pool.project) &&
      !seenMissingProtocols.has(pool.project)
    ) {
      seenMissingProtocols.add(pool.project);
      missingProtocols.push(poolEntry);
    }
  }

  // Sort by TVL descending for easier triage
  unmatchedHighTvlPools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  missingProtocols.sort((a, b) => b.tvlUsd - a.tvlUsd);

  const yieldBearingIdsBySymbol = buildYieldBearingSymbolIndex();
  const nativeExactPoolRecommendations = uncoveredStablecoinPools
    .filter((pool) => pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD)
    .flatMap((pool) => {
      const stablecoinIds = yieldBearingIdsBySymbol.get(normalizeRecommendationSymbol(pool.symbol));
      return stablecoinIds
        ? [{ ...pool, stablecoinIds }]
        : [];
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 50);

  const sourceFamilyAdapterRecommendations = buildProtocolRecommendations(
    uncoveredStablecoinPools.filter((pool) => SOURCE_FAMILY_ADAPTER_PROJECTS.has(pool.project)),
  );
  const lendingAllowlistRecommendations = buildProtocolRecommendations(
    uncoveredStablecoinPools.filter((pool) => !supportedProtocols.has(pool.project) && !SOURCE_FAMILY_ADAPTER_PROJECTS.has(pool.project)),
  );
  const protocolRecommendations = buildProtocolRecommendations(
    uncoveredStablecoinPools.filter((pool) => !supportedProtocols.has(pool.project)),
  );

  return {
    unmatchedHighTvlPools,
    missingProtocols,
    protocolRecommendations,
    nativeExactPoolRecommendations,
    sourceFamilyAdapterRecommendations,
    lendingAllowlistRecommendations,
  };
}

/**
 * Async cron function: loads DL pools from cache/API, loads the existing yield
 * coverage state from the DB, computes gaps, and persists a summary report.
 */
export async function runYieldCoverageAudit(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  // Load DL stablecoin pools (uses cache written by dex-liquidity sync)
  const { pools: dlPools, meta: poolMeta } = await loadDlStablecoinPools(db, signal);

  if (dlPools.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "no-dl-pools",
        poolMeta,
      }),
    };
  }

  // Track the exact DL pool IDs already covered by static native mappings,
  // explicit auto-discovery overrides, and curated exact-pool overrides.
  const coveredPools = new Set([
    ...Object.values(YIELD_POOL_MAP),
    ...Object.values(AUTO_LENDING_POOL_MAP),
    ...Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP).flat().map((config) => config.poolId),
    ...Object.values(YIELD_WEIGHTED_POOL_GROUPS).flatMap((config) => config.poolIds),
  ]);
  const gaps = identifyCoverageGaps(dlPools, coveredPools, LENDING_PROTOCOL_ALLOWLIST);
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

  let publishedYieldIds = new Set<string>();
  const rankingsCache = readCachedJson<{ rankings?: Array<{ id?: string }> }>(
    "yield-coverage-audit",
    "yield-rankings",
    await getCache(db, "yield-rankings"),
  );
  if (rankingsCache.status === "ok") {
    const parsed = rankingsCache.data;
      publishedYieldIds = new Set(
        (parsed.rankings ?? [])
          .map((ranking) => ranking.id)
          .filter((id): id is string => typeof id === "string"),
      );
  }

  const yieldBearingMissingFromRankings = ACTIVE_YIELD_BEARING_STABLECOINS
    .filter((coin) => {
      const manifestEntry = manifestById.get(coin.id);
      return manifestEntry?.status !== "intentional-gap" && !publishedYieldIds.has(coin.id);
    })
    .map((coin) => coin.id);
  const operatorQueue = buildCoverageAuditOperatorQueue({
    gaps,
    manifestMissingIds,
    yieldBearingMissingFromRankings,
  });

  const lifecycleBuckets = summarizeAdapterLifecycle(
    ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id),
  );

  const reportedAt = Math.floor(Date.now() / 1000);
  const report = {
    reportedAt,
    totalDlPools: dlPools.length,
    coveredPoolCount: coveredPools.size,
    manifestYieldBearingCount: YIELD_ADAPTER_MANIFEST.length,
    manifestMissingIds,
    intentionalGapIds,
    yieldBearingMissingFromRankings,
    unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
    missingProtocolCount: gaps.missingProtocols.length,
    protocolRecommendationCount: gaps.protocolRecommendations.length,
    nativeExactPoolRecommendationCount: gaps.nativeExactPoolRecommendations.length,
    sourceFamilyAdapterRecommendationCount: gaps.sourceFamilyAdapterRecommendations.length,
    lendingAllowlistRecommendationCount: gaps.lendingAllowlistRecommendations.length,
    exactPoolOverrideCount: explicitPoolOverrides.length,
    exactPoolOverrideYieldBearingCount: exactPoolOverrideYieldBearingIds.length,
    exactPoolOverrideNonYieldBearingOpportunityCount: exactPoolOverrideNonYieldBearingOpportunityIds.length,
    exactPoolOverrideYieldBearingIds,
    exactPoolOverrideNonYieldBearingOpportunityIds,
    exactPoolOverrides: explicitPoolOverrides,
    unmatchedHighTvlPools: gaps.unmatchedHighTvlPools.slice(0, 50),
    missingProtocols: gaps.missingProtocols.slice(0, 50),
    protocolRecommendations: gaps.protocolRecommendations,
    nativeExactPoolRecommendations: gaps.nativeExactPoolRecommendations,
    sourceFamilyAdapterRecommendations: gaps.sourceFamilyAdapterRecommendations,
    lendingAllowlistRecommendations: gaps.lendingAllowlistRecommendations,
    operatorQueue,
    lifecycleSummary: lifecycleBuckets.lifecycleSummary,
    quarantinedAdapters: lifecycleBuckets.quarantinedAdapters,
    intentionalGaps: lifecycleBuckets.intentionalGaps,
    manifest: YIELD_ADAPTER_MANIFEST.map((entry) => ({
      stablecoinId: entry.stablecoinId,
      status: entry.status,
      strategyKinds: entry.strategies.map((strategy) => strategy.kind),
      strategyLabels: entry.strategies.map((strategy) => strategy.label),
    })),
    poolMeta,
  };

  await setCache(db, "yield-coverage-audit", JSON.stringify(report));

  const itemCount =
    gaps.unmatchedHighTvlPools.length +
    gaps.missingProtocols.length +
    gaps.nativeExactPoolRecommendations.length +
    gaps.sourceFamilyAdapterRecommendations.length +
    gaps.lendingAllowlistRecommendations.length +
    manifestMissingIds.length +
    yieldBearingMissingFromRankings.length;

  return {
    status: "ok",
    itemCount,
    metadata: JSON.stringify({
      totalDlPools: dlPools.length,
      coveredPoolCount: coveredPools.size,
      manifestYieldBearingCount: YIELD_ADAPTER_MANIFEST.length,
      manifestMissingCount: manifestMissingIds.length,
      intentionalGapCount: intentionalGapIds.length,
      yieldBearingMissingFromRankingsCount: yieldBearingMissingFromRankings.length,
      unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
      missingProtocolCount: gaps.missingProtocols.length,
      protocolRecommendationCount: gaps.protocolRecommendations.length,
      nativeExactPoolRecommendationCount: gaps.nativeExactPoolRecommendations.length,
      sourceFamilyAdapterRecommendationCount: gaps.sourceFamilyAdapterRecommendations.length,
      lendingAllowlistRecommendationCount: gaps.lendingAllowlistRecommendations.length,
      exactPoolOverrideCount: explicitPoolOverrides.length,
      exactPoolOverrideNonYieldBearingOpportunityCount: exactPoolOverrideNonYieldBearingOpportunityIds.length,
    }),
  };
}
