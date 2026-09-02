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
import {
  explainDeterministicAutoLendingEligibility,
  type AutoLendingEligibilityReasonCode,
} from "./yield-sync/resolve-helpers";
import { computeSafetyScoresSnapshot, type PublishedSafetyScoresResultMap } from "../lib/safety-scores";
import { buildStablecoinSupplyMapFromCacheValue } from "./yield-sync/supply-map";
import type { YieldAdapterLifecycleEntry } from "../lib/yield-config/yield-config-registry";
import { YIELD_ADAPTER_LIFECYCLE } from "../lib/yield-config/yield-config-rate-sources";
import {
  probeQuarantinedDeterministicAdapters,
  type QuarantineRestoreCandidate,
} from "./yield-coverage-audit-quarantine";
import {
  applyYieldCoverageReviewDispositions,
  type YieldCoverageReviewDispositionSummary,
} from "./yield-coverage-review-dispositions";
import type {
  YieldCoverageAuditQueueAction,
  YieldCoverageAuditQueueItem,
  YieldCoverageAuditQueueItemKind,
} from "@shared/types/status";
import type { YieldAdapterLifecycle } from "@shared/types/yield";
import type { DlPool } from "./yield-sync/types";
import { resolveReviewedYieldRiskConfig, type StaleVenueRiskScore } from "@shared/lib/yield-source-risk-registry";
import { findStaleVenueRiskScores } from "./yield-sync/source-risk";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";

/** Minimum TVL (USD) for a pool to be flagged as an unmatched high-TVL pool. */
const HIGH_TVL_THRESHOLD_USD = 5_000_000;
/** TVL floor (USD) for a protocol to be promoted to the high-confidence recommendation tier. */
const HIGH_CONFIDENCE_TVL_USD = 10_000_000;
/** Minimum pool count for a protocol to reach the high-confidence recommendation tier. */
const HIGH_CONFIDENCE_MIN_POOL_COUNT = 3;
const OPERATOR_QUEUE_ITEM_LIMIT = 20;
const REPORT_HEADLINE_ITEM_LIMIT = 50;
const ALLOWLIST_AUDIT_QUEUE_ANCHOR = "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR";
const DEFILLAMA_PROTOCOLS_SOURCE_URL = "https://api.llama.fi/protocols";
const DEFILLAMA_YIELD_POOL_CHART_URL = "https://yields.llama.fi/chart";
const OPERATOR_QUEUE_ACTIONS = [
  "accept",
  "dismiss",
  "intentional-gap",
  "watch",
] as const satisfies readonly YieldCoverageAuditQueueAction[];
const LIFECYCLE_BUCKET_LIMIT = 100;
const HIGH_CONFIDENCE_PROTOCOL_CATEGORIES = new Set([
  "cdp",
  "lending",
  "rwa lending",
  "uncollateralized lending",
]);
const YIELD_COVERAGE_AUDIT_PROGRESS_STAGES = 6;

export interface ProtocolCategoryAuditMeta {
  cacheKey: typeof CIRCUIT_SOURCE.DL_PROTOCOLS;
  status: "ok" | "missing" | "malformed";
  protocolCount: number;
  categorizedProtocolCount: number;
  highConfidenceCategoryCount: number;
}

function normalizeProtocolProjectKey(project: string): string {
  return project.trim().toLowerCase();
}

function normalizeProtocolCategory(category: string | null | undefined): string | null {
  const normalized = category?.trim();
  return normalized ? normalized : null;
}

function protocolRowsFromCachePayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload == null || typeof payload !== "object") return [];
  const envelope = payload as { data?: unknown; protocols?: unknown };
  if (Array.isArray(envelope.protocols)) return envelope.protocols;
  return Array.isArray(envelope.data) ? envelope.data : [];
}

export function isHighConfidenceProtocolCategory(category: string | null | undefined): boolean {
  const normalized = normalizeProtocolCategory(category)?.toLowerCase();
  return normalized != null && HIGH_CONFIDENCE_PROTOCOL_CATEGORIES.has(normalized);
}

export function buildProtocolCategoryLookupFromCachePayload(payload: unknown): Map<string, string> {
  const categories = new Map<string, string>();
  for (const row of protocolRowsFromCachePayload(payload)) {
    if (row == null || typeof row !== "object") continue;
    const protocol = row as { category?: unknown; slug?: unknown };
    if (typeof protocol.slug !== "string" || typeof protocol.category !== "string") continue;
    const category = normalizeProtocolCategory(protocol.category);
    if (!category) continue;
    categories.set(normalizeProtocolProjectKey(protocol.slug), category);
  }
  return categories;
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
  persistence: "deferred" | "durable";
  promotionMode: "human-reviewed";
  allowedActions: YieldCoverageAuditQueueAction[];
  headlineGaps: CoverageAuditQueueItem[];
  recommendationCandidates: CoverageAuditQueueItem[];
  suppressedItemCount: number;
}

export interface StaleAutoLendingOverride {
  stablecoinId: string;
  pool: string;
  reasons: string[];
  project: string | null;
  symbol: string | null;
  chain: string | null;
  tvlUsd: number | null;
  apy: number | null;
  requiredMinTvlUsd: number | null;
}

interface IdentifyStaleAutoLendingOverrideOptions {
  stablecoinSupplyById?: Map<string, number>;
  safetyScores?: Map<string, { score: number }>;
}

const AUTO_LENDING_AUDIT_REASON: Record<AutoLendingEligibilityReasonCode, string> = {
  collision: "collision-blocked",
  "safety-score": "below-safety-score",
  "pool-exposure": "non-single-exposure",
  "pool-stablecoin": "not-stablecoin",
  "protocol-allowlist": "project-not-allowlisted",
  "apy-floor": "below-apy-floor",
  "tvl-floor": "below-tvl-floor",
  "source-blocked": "blocked-source",
};

export interface CoverageGapPool {
  pool: string;
  project: string;
  protocolCategory: string | null;
  symbol: string;
  chain: string;
  tvlUsd: number;
  apy: number;
}

export interface ProtocolRecommendationExamplePool extends CoverageGapPool {
  sourceUrl: string;
}

export interface ProtocolRecommendationSourceLink {
  label: string;
  url: string;
}

export interface ProtocolRecommendationSuggestedConfig {
  targetFile: "worker/src/lib/yield-config/yield-config-lending-protocols.ts";
  exportName: "LENDING_PROTOCOLS";
  anchor: typeof ALLOWLIST_AUDIT_QUEUE_ANCHOR;
  snippet: string;
  notes: string[];
}

export interface ProtocolRecommendationPromotionMetadata {
  sourceQueue: "monthly-unmatched-high-tvl" | "uncovered-stablecoin-pools";
  sourceQueueField: "unmatchedHighTvlPools" | "uncoveredStablecoinPools";
  minPoolTvlUsd: number;
  queueQualifiedPoolCount: number;
  categoryGate: string[];
  passedCategoryGate: boolean;
  existingAllowlistMember: boolean;
}

export interface ProtocolRecommendation {
  project: string;
  protocolCategory: string | null;
  poolCount: number;
  totalTvlUsd: number;
  recommendedTier: "high-confidence" | "review-needed";
  examplePools: string[];
  examplePoolDetails: ProtocolRecommendationExamplePool[];
  sourceLinks: ProtocolRecommendationSourceLink[];
  suggestedConfig: ProtocolRecommendationSuggestedConfig | null;
  promotionMetadata: ProtocolRecommendationPromotionMetadata;
}

export interface NativeExactPoolRecommendation extends CoverageGapPool {
  stablecoinIds: string[];
}

export interface VenueRiskConfigMissing {
  project: string;
  protocolCategory: string | null;
  poolCount: number;
  totalTvlUsd: number;
  examplePools: string[];
  examplePoolDetails: ProtocolRecommendationExamplePool[];
  sourceLinks: ProtocolRecommendationSourceLink[];
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
  /** Covered or allowlisted high-TVL venue slugs missing reviewed venue-risk config/aliases. */
  venueRiskConfigMissing: VenueRiskConfigMissing[];
}

export interface CoverageAuditQueueItem extends YieldCoverageAuditQueueItem {
  protocolCategory?: string | null;
  examplePools?: string[];
  examplePoolDetails?: ProtocolRecommendationExamplePool[];
  sourceLinks?: ProtocolRecommendationSourceLink[];
  suggestedConfig?: ProtocolRecommendationSuggestedConfig | null;
  promotionMetadata?: ProtocolRecommendationPromotionMetadata;
  reasonCodes?: string[];
  sourceKey?: string;
  reviewedAt?: string;
  reviewConfidence?: string;
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

function buildCoverageGapPool(pool: DlPool, protocolCategory: string | null): CoverageGapPool {
  return {
    pool: pool.pool,
    project: pool.project,
    protocolCategory,
    symbol: pool.symbol,
    chain: pool.chain,
    tvlUsd: pool.tvlUsd,
    apy: pool.apy,
  };
}

function buildYieldPoolSourceUrl(poolId: string): string {
  return `${DEFILLAMA_YIELD_POOL_CHART_URL}/${encodeURIComponent(poolId)}`;
}

function inferProtocolLabel(project: string): string {
  return project
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function buildSuggestedLendingAllowlistConfig(project: string): ProtocolRecommendationSuggestedConfig {
  return {
    targetFile: "worker/src/lib/yield-config/yield-config-lending-protocols.ts",
    exportName: "LENDING_PROTOCOLS",
    anchor: ALLOWLIST_AUDIT_QUEUE_ANCHOR,
    snippet: `  ${JSON.stringify(project)}: { label: ${JSON.stringify(inferProtocolLabel(project))} },`,
    notes: [
      "Verify the display label before promoting.",
      "Keep the protocol near the audit-queue comment anchor for the current round.",
    ],
  };
}

interface ProjectPoolAggregation {
  base: VenueRiskConfigMissing;
  sortedPools: CoverageGapPool[];
}

function aggregatePoolsByProject(
  pools: CoverageGapPool[],
  options: {
    minTotalTvlUsd?: number;
    hasProtocolCategory?: (category: string | null) => boolean;
  } = {},
): ProjectPoolAggregation[] {
  const byProject = new Map<string, { pools: CoverageGapPool[]; tvl: number }>();
  for (const pool of pools) {
    const entry = byProject.get(pool.project) ?? { pools: [], tvl: 0 };
    entry.pools.push(pool);
    entry.tvl += pool.tvlUsd;
    byProject.set(pool.project, entry);
  }

  return [...byProject.entries()]
    .filter(([, value]) => options.minTotalTvlUsd == null || value.tvl >= options.minTotalTvlUsd)
    .map(([project, value]) => {
      const sortedPools = [...value.pools].sort((a, b) => b.tvlUsd - a.tvlUsd);
      const hasProtocolCategory = options.hasProtocolCategory ?? ((category) => category != null);
      const protocolCategory = sortedPools.find((pool) => hasProtocolCategory(pool.protocolCategory))
        ?.protocolCategory ?? null;
      const examplePoolDetails = sortedPools.slice(0, 3).map((pool) => ({
        ...pool,
        sourceUrl: buildYieldPoolSourceUrl(pool.pool),
      }));
      const base: VenueRiskConfigMissing = {
        project,
        protocolCategory,
        poolCount: value.pools.length,
        totalTvlUsd: value.tvl,
        examplePools: examplePoolDetails.map((pool) => pool.pool),
        examplePoolDetails,
        sourceLinks: [
          {
            label: "DeFiLlama protocols category source",
            url: DEFILLAMA_PROTOCOLS_SOURCE_URL,
          },
          ...examplePoolDetails.map((pool) => ({
            label: `DeFiLlama yield chart: ${pool.symbol} on ${pool.chain}`,
            url: pool.sourceUrl,
          })),
        ],
      };
      return { base, sortedPools };
    })
    .sort((a, b) => b.base.totalTvlUsd - a.base.totalTvlUsd)
    .slice(0, 20);
}

function buildProtocolRecommendations(
  pools: CoverageGapPool[],
  options: {
    sourceQueue: ProtocolRecommendationPromotionMetadata["sourceQueue"];
    sourceQueueField: ProtocolRecommendationPromotionMetadata["sourceQueueField"];
    includeAllowlistConfig: boolean;
  } = {
    sourceQueue: "uncovered-stablecoin-pools",
    sourceQueueField: "uncoveredStablecoinPools",
    includeAllowlistConfig: false,
  },
): ProtocolRecommendation[] {
  return aggregatePoolsByProject(pools, { minTotalTvlUsd: HIGH_TVL_THRESHOLD_USD })
    .map(({ base, sortedPools }) => {
      const recommendedTier: ProtocolRecommendation["recommendedTier"] =
        base.totalTvlUsd >= HIGH_CONFIDENCE_TVL_USD &&
        base.poolCount >= HIGH_CONFIDENCE_MIN_POOL_COUNT &&
        isHighConfidenceProtocolCategory(base.protocolCategory)
          ? "high-confidence"
          : "review-needed";
      const queueQualifiedPoolCount = sortedPools
        .filter((pool) => pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD).length;
      return {
        project: base.project,
        protocolCategory: base.protocolCategory,
        poolCount: base.poolCount,
        totalTvlUsd: base.totalTvlUsd,
        recommendedTier,
        examplePools: base.examplePools,
        examplePoolDetails: base.examplePoolDetails,
        sourceLinks: base.sourceLinks,
        suggestedConfig: options.includeAllowlistConfig
          ? buildSuggestedLendingAllowlistConfig(base.project)
          : null,
        promotionMetadata: {
          sourceQueue: options.sourceQueue,
          sourceQueueField: options.sourceQueueField,
          minPoolTvlUsd: HIGH_TVL_THRESHOLD_USD,
          queueQualifiedPoolCount,
          categoryGate: [...HIGH_CONFIDENCE_PROTOCOL_CATEGORIES].sort(),
          passedCategoryGate: isHighConfidenceProtocolCategory(base.protocolCategory),
          existingAllowlistMember: LENDING_PROTOCOL_ALLOWLIST.has(base.project),
        },
      };
    });
}

function buildVenueRiskConfigMissing(pools: CoverageGapPool[]): VenueRiskConfigMissing[] {
  return aggregatePoolsByProject(pools, {
    hasProtocolCategory: (category) => Boolean(category),
  }).map(({ base }) => base);
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

function buildStaleOverrideQueueItem(override: StaleAutoLendingOverride): CoverageAuditQueueItem {
  return {
    id: queueId("stale-auto-lending-override", `${override.stablecoinId}:${override.pool}`),
    kind: "stale-auto-lending-override" as const,
    title: override.stablecoinId,
    detail: `Override ${override.pool} no longer qualifies: ${override.reasons.join(", ")}`,
    actionHint: "accept" as const,
    stablecoinIds: [override.stablecoinId],
    pool: override.pool,
    project: override.project ?? undefined,
    symbol: override.symbol ?? undefined,
    chain: override.chain ?? undefined,
    tvlUsd: override.tvlUsd ?? undefined,
    apy: override.apy ?? undefined,
    reasonCodes: [...override.reasons],
  };
}

function buildProtocolQueueItem(
  kind: Extract<YieldCoverageAuditQueueItemKind, "source-family-adapter" | "lending-allowlist">,
  recommendation: ProtocolRecommendation,
): CoverageAuditQueueItem {
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
    protocolCategory: recommendation.protocolCategory,
    examplePools: recommendation.examplePools,
    examplePoolDetails: recommendation.examplePoolDetails,
    sourceLinks: recommendation.sourceLinks,
    suggestedConfig: kind === "lending-allowlist" ? recommendation.suggestedConfig : null,
    promotionMetadata: recommendation.promotionMetadata,
  };
}

function buildVenueRiskConfigMissingQueueItem(
  missing: VenueRiskConfigMissing,
): CoverageAuditQueueItem {
  return {
    id: queueId("venue-risk-config-missing", missing.project),
    kind: "venue-risk-config-missing" as const,
    title: missing.project,
    detail: `${missing.poolCount} covered high-TVL pool(s) resolve to unknown venue risk; add a reviewed registry entry or alias.`,
    actionHint: "accept" as const,
    project: missing.project,
    poolCount: missing.poolCount,
    totalTvlUsd: missing.totalTvlUsd,
    protocolCategory: missing.protocolCategory,
    examplePools: missing.examplePools,
    examplePoolDetails: missing.examplePoolDetails,
    sourceLinks: missing.sourceLinks,
  };
}

export function buildCoverageAuditOperatorQueue({
  gaps,
  manifestMissingIds,
  yieldBearingMissingFromRankings,
  staleAutoLendingOverrides = [],
  quarantineReadyToRestore = [],
  nowMs = Date.now(),
  staleVenueRiskScores = findStaleVenueRiskScores(nowMs),
}: {
  gaps: CoverageGaps;
  manifestMissingIds: string[];
  yieldBearingMissingFromRankings: string[];
  staleAutoLendingOverrides?: StaleAutoLendingOverride[];
  quarantineReadyToRestore?: QuarantineRestoreCandidate[];
  nowMs?: number;
  staleVenueRiskScores?: StaleVenueRiskScore[];
}): CoverageAuditOperatorQueue {
  const headlineGaps: CoverageAuditQueueItem[] = [
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
    ...staleAutoLendingOverrides.map(buildStaleOverrideQueueItem),
    ...gaps.unmatchedHighTvlPools.map((pool) => buildPoolQueueItem("unmatched-high-tvl-pool", pool, "watch")),
    ...gaps.missingProtocols.map((pool) => buildPoolQueueItem("missing-protocol", pool, "watch")),
  ];

  const recommendationCandidates: CoverageAuditQueueItem[] = [
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
    ...gaps.venueRiskConfigMissing.map(buildVenueRiskConfigMissingQueueItem),
    ...quarantineReadyToRestore.map((candidate) => ({
      id: queueId("quarantine-ready-to-restore", candidate.stablecoinId),
      kind: "quarantine-ready-to-restore" as const,
      title: candidate.stablecoinId,
      detail: `${candidate.chain} ${candidate.sourceKey} probe returned ${candidate.exchangeRate}`,
      actionHint: "accept" as const,
      stablecoinIds: [candidate.stablecoinId],
      chain: candidate.chain,
      sourceKey: candidate.sourceKey,
      reasonCodes: [candidate.code],
    })),
    ...staleVenueRiskScores.map((stale) => ({
      id: queueId("stale-venue-risk-score", stale.protocol),
      kind: "stale-venue-risk-score" as const,
      title: stale.protocol,
      detail: `Venue-risk score last reviewed ${stale.reviewedAt} (${stale.ageDays}d ago${
        stale.confidence && stale.confidence !== "verified" ? `, ${stale.confidence} confidence` : ""
      }); re-verify audits, governance, and TVL.`,
      actionHint: "watch" as const,
      project: stale.protocol,
      reviewedAt: stale.reviewedAt,
      reviewConfidence: stale.confidence,
    })),
  ];

  return {
    persistence: "deferred",
    promotionMode: "human-reviewed",
    allowedActions: [...OPERATOR_QUEUE_ACTIONS],
    headlineGaps,
    recommendationCandidates,
    suppressedItemCount: 0,
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
  protocolCategoriesByProject: Map<string, string> = new Map(),
): CoverageGaps {
  const unmatchedHighTvlPools: CoverageGapPool[] = [];
  const missingProtocols: CoverageGapPool[] = [];
  const seenMissingProtocols = new Set<string>();
  const uncoveredStablecoinPools: CoverageGapPool[] = [];
  const venueRiskConfigMissingPools: CoverageGapPool[] = [];

  for (const pool of dlPools) {
    const protocolCategory = protocolCategoriesByProject.get(normalizeProtocolProjectKey(pool.project)) ?? null;
    const poolEntry = buildCoverageGapPool(pool, protocolCategory);
    const coveredByProtocolOrExactPool = supportedProtocols.has(pool.project) || coveredPools.has(pool.pool);
    if (
      coveredByProtocolOrExactPool &&
      pool.exposure === "single" &&
      pool.stablecoin &&
      pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD &&
      resolveReviewedYieldRiskConfig(pool.project) == null
    ) {
      venueRiskConfigMissingPools.push(poolEntry);
    }

    // Skip pools already covered for generic coverage-gap queues. Venue-risk
    // drift is checked above because exact covered pools can still expose a
    // project slug that no reviewed venue-risk config or alias recognizes.
    if (coveredPools.has(pool.pool)) continue;

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
  const unmatchedHighTvlStablecoinPoolIds = new Set(unmatchedHighTvlPools.map((pool) => pool.pool));
  const lendingAllowlistRecommendations = buildProtocolRecommendations(
    uncoveredStablecoinPools.filter((pool) =>
      unmatchedHighTvlStablecoinPoolIds.has(pool.pool) &&
      !supportedProtocols.has(pool.project) &&
      !SOURCE_FAMILY_ADAPTER_PROJECTS.has(pool.project) &&
      isHighConfidenceProtocolCategory(pool.protocolCategory)
    ),
    {
      sourceQueue: "monthly-unmatched-high-tvl",
      sourceQueueField: "unmatchedHighTvlPools",
      includeAllowlistConfig: true,
    },
  );
  const protocolRecommendations = buildProtocolRecommendations(
    uncoveredStablecoinPools.filter((pool) => !supportedProtocols.has(pool.project)),
  );
  const venueRiskConfigMissing = buildVenueRiskConfigMissing(venueRiskConfigMissingPools);

  return {
    unmatchedHighTvlPools,
    missingProtocols,
    protocolRecommendations,
    nativeExactPoolRecommendations,
    sourceFamilyAdapterRecommendations,
    lendingAllowlistRecommendations,
    venueRiskConfigMissing,
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

export function identifyStaleAutoLendingOverrides(
  dlPools: DlPool[],
  options: IdentifyStaleAutoLendingOverrideOptions = {},
): StaleAutoLendingOverride[] {
  const poolById = new Map(dlPools.map((pool) => [pool.pool, pool] as const));
  const staleOverrides: StaleAutoLendingOverride[] = [];
  const stablecoinSupplyById = options.stablecoinSupplyById ?? new Map();
  const safetyScores = options.safetyScores;

  for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
    const pool = poolById.get(poolId);
    if (!pool) {
      staleOverrides.push({
        stablecoinId,
        pool: poolId,
        reasons: ["missing-pool"],
        project: null,
        symbol: null,
        chain: null,
        tvlUsd: null,
        apy: null,
        requiredMinTvlUsd: null,
      });
      continue;
    }

    const verdict = explainDeterministicAutoLendingEligibility({
      stablecoinId,
      pool,
      safetyScore: safetyScores?.get(stablecoinId)?.score,
      safetySnapshotAvailable: safetyScores != null,
      stablecoinSupplyById,
    });
    if (verdict.eligible) continue;
    const reasons = verdict.reasonCodes.map((reason) => AUTO_LENDING_AUDIT_REASON[reason]);

    staleOverrides.push({
      stablecoinId,
      pool: poolId,
      reasons,
      project: pool.project,
      symbol: pool.symbol,
      chain: pool.chain,
      tvlUsd: pool.tvlUsd,
      apy: pool.apy,
      requiredMinTvlUsd: verdict.requiredMinTvlUsd,
    });
  }

  return staleOverrides.sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
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
  const gaps = identifyCoverageGaps(
    dlPools,
    coveredPools,
    LENDING_PROTOCOL_ALLOWLIST,
    protocolCategoryLookup.categoriesByProject,
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
  const lifecycleBuckets = summarizeAdapterLifecycle(
    ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id),
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
  const nowMs = Date.now();
  const staleVenueRiskScores = findStaleVenueRiskScores(nowMs);
  const candidateOperatorQueue = buildCoverageAuditOperatorQueue({
    gaps,
    manifestMissingIds,
    yieldBearingMissingFromRankings,
    staleAutoLendingOverrides,
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
  // The 13 count fields shared between the persisted report payload and the
  // CronResult metadata. The two payloads otherwise diverge deliberately.
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
      protocolCategoryStatus,
      protocolCategoryCount: protocolCategoryLookup.meta.categorizedProtocolCount,
      quarantineReadyToRestoreCount: quarantineProbe.readyToRestore.length,
      quarantineProbeAttemptedCount: quarantineProbe.summary.attemptedCount,
      safetyScoreIdentity: safetySnapshot.safetyScoreIdentity,
    },
  });
}
