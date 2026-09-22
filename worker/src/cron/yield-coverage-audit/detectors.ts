import { normalizeChainId } from "@shared/lib/chains";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  findStaleVenueRiskScores,
  resolveReviewedYieldRiskConfig,
  type StaleVenueRiskScore,
} from "@shared/lib/yield-source-risk-registry";
import type {
  YieldCoverageAuditQueueAction,
  YieldCoverageAuditQueueItem,
  YieldCoverageAuditQueueItemKind,
} from "@shared/types/status";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import {
  AUTO_LENDING_POOL_MAP,
  LENDING_PROTOCOL_ALLOWLIST,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "../../lib/yield-config/yield-config";
import type { QuarantineRestoreCandidate } from "../yield-coverage-audit-quarantine";
import { resolveYieldSourceKeyRoute } from "../yield-sync/yield-source-key-routing";
import {
  explainDeterministicAutoLendingEligibility,
  type AutoLendingEligibilityReasonCode,
} from "../yield-sync/resolve-helpers";
import type { DlPool } from "../yield-sync/types";

/** Minimum TVL (USD) for a pool to be flagged as an unmatched high-TVL pool. */
const HIGH_TVL_THRESHOLD_USD = 5_000_000;
/** TVL floor (USD) for a protocol to be promoted to the high-confidence recommendation tier. */
const HIGH_CONFIDENCE_TVL_USD = 10_000_000;
/** Minimum pool count for a protocol to reach the high-confidence recommendation tier. */
const HIGH_CONFIDENCE_MIN_POOL_COUNT = 3;
const OPERATOR_QUEUE_ITEM_LIMIT = 20;
/** Bound on native-pool candidate groups carried in the gaps payload. */
const NATIVE_EXACT_POOL_GROUP_LIMIT = 50;
const ALLOWLIST_AUDIT_QUEUE_ANCHOR = "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR";
const DEFILLAMA_PROTOCOLS_SOURCE_URL = "https://api.llama.fi/protocols";
const DEFILLAMA_YIELD_POOL_CHART_URL = "https://yields.llama.fi/chart";
const OPERATOR_QUEUE_ACTIONS = [
  "accept",
  "dismiss",
  "intentional-gap",
  "watch",
] as const satisfies readonly YieldCoverageAuditQueueAction[];
const HIGH_CONFIDENCE_PROTOCOL_CATEGORIES = new Set([
  "cdp",
  "lending",
  "rwa lending",
  "uncollateralized lending",
]);

function normalizeProtocolProjectKey(project: string): string {
  return project.trim().toLowerCase();
}

function normalizeProtocolCategory(category: string | null | undefined): string | null {
  const normalized = category?.trim();
  return normalized ? normalized : null;
}

export function protocolRowsFromCachePayload(payload: unknown): unknown[] {
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

/** Registry that pins a curated DeFiLlama yield surface for one asset (B20). */
export type CuratedPinRegistry = "native-pool" | "variant-pool" | "weighted-pool-group";

/**
 * A curated pin whose DeFiLlama surface has disappeared. `missing-pool` is the
 * only reason this detector emits; `coverage` cross-references the published
 * rankings so a dead config is distinguishable from a live coverage outage.
 */
export interface DeadCuratedPin {
  stablecoinId: string;
  registry: CuratedPinRegistry;
  /** Representative pin value: the absent pool id, or the variant identity. */
  pin: string;
  /** Absent curated pool ids (empty for a variant pin, which resolves by symbol). */
  missingPoolIds: string[];
  /** Curated pool ids still in the snapshot; a weighted group can fail while partial. */
  presentPoolIds: string[];
  reasons: string[];
  /**
   * `coverage-outage` when the asset publishes no ranking row, `dead-config`
   * when it still publishes through another source, `null` when the caller did
   * not supply the published ranking ids.
   */
  coverage: "coverage-outage" | "dead-config" | null;
}

export interface IdentifyDeadCuratedPinsOptions {
  /** Stablecoin ids present in the latest published yield rankings cache. */
  publishedStablecoinIds?: ReadonlySet<string>;
}

const AUTO_LENDING_AUDIT_REASON: Record<AutoLendingEligibilityReasonCode, string> = {
  collision: "collision-blocked",
  "safety-score": "below-safety-score",
  "pool-exposure": "non-single-exposure",
  "pool-stablecoin": "not-stablecoin",
  "protocol-allowlist": "project-not-allowlisted",
  "apy-floor": "below-apy-floor",
  "tvl-floor": "below-tvl-floor",
  "supply-map-unavailable": "supply-map-unavailable",
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

/**
 * One tracked yield-bearing asset (or symbol-sharing asset set) with uncovered
 * high-TVL DeFiLlama pools that look like its native yield surface. Grouped per
 * resolved asset so a six-chain deployment is one decision, not six queue rows.
 * The `CoverageGapPool` fields describe the group's largest pool.
 */
export interface NativeExactPoolRecommendation extends CoverageGapPool {
  stablecoinIds: string[];
  /** Every grouped pool id, highest TVL first. */
  poolIds: string[];
  /** Distinct chains in the group, highest TVL first. */
  chains: string[];
  poolCount: number;
  totalTvlUsd: number;
}

export interface VenueRiskConfigMissing {
  /** Slug an operator would add to the reviewed venue-risk registry. */
  project: string;
  protocolCategory: string | null;
  poolCount: number;
  totalTvlUsd: number;
  examplePools: string[];
  examplePoolDetails: ProtocolRecommendationExamplePool[];
  sourceLinks: ProtocolRecommendationSourceLink[];
  /** Published ranking assets behind a row-derived candidate (empty for pool-derived). */
  stablecoinIds?: string[];
  /** Source keys of those rows; they show which route or alias is unreviewed. */
  sourceKeys?: string[];
}

/** Published ranking row reduced to the venue evidence the audit needs (A10). */
export interface PublishedYieldVenueRow {
  stablecoinId: string;
  /** Venue slug published in `sourceRisk.venueProtocol`, or null when unresolved. */
  venueProtocol: string | null;
  /** Publication provenance source key, used to recover a venue through the route table. */
  sourceKey: string | null;
  sourceTvlUsd: number | null;
}

export interface IdentifyCoverageGapsOptions {
  /** Latest published ranking rows, for row-derived venue-risk candidates (A10). */
  publishedVenueRows?: readonly PublishedYieldVenueRow[];
  /** Stablecoin ids already present in the published rankings (native-pool gate, C7). */
  publishedStablecoinIds?: ReadonlySet<string>;
}

export interface CoverageGaps {
  /**
   * High-TVL uncovered pools on unsupported protocols whose DeFiLlama category
   * is a lending family or unknown, so an allowlist entry can still fix them.
   */
  unmatchedHighTvlPools: CoverageGapPool[];
  /**
   * One representative pool per unsupported protocol whose known DeFiLlama
   * category is outside the lending families, so the lending allowlist is not
   * the remedy. Gated on the same high-TVL floor as the headline queue.
   */
  missingProtocols: CoverageGapPool[];
  /** Actionable protocol recommendations based on TVL and pool count. */
  protocolRecommendations: ProtocolRecommendation[];
  /** High-TVL pools that look like native yield surfaces for tracked yield-bearing assets. */
  nativeExactPoolRecommendations: NativeExactPoolRecommendation[];
  /** High-TVL pools on protocol families that should be handled by source-family adapters. */
  sourceFamilyAdapterRecommendations: ProtocolRecommendation[];
  /** High-TVL non-allowlisted lending protocols that may warrant allowlist review. */
  lendingAllowlistRecommendations: ProtocolRecommendation[];
  /** Covered pools and published rows whose venue slug has no reviewed venue-risk config. */
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
  // SRC-SUPP-4: a merged candidate carries both a covered-pool aggregate and
  // the published rows that resolved to the same venue slug.
  const publishedRowCount = missing.stablecoinIds?.length ?? 0;
  const poolDerived = missing.examplePools.length > 0;
  const detail = publishedRowCount > 0
    ? poolDerived
      ? `${missing.poolCount} covered high-TVL pool(s) and ${publishedRowCount} published row(s) resolve to unknown venue risk; add a reviewed registry entry or alias.`
      : `${publishedRowCount} published row(s) above the high-TVL floor resolve to unknown venue risk; add a reviewed registry entry or alias.`
    : `${missing.poolCount} covered high-TVL pool(s) resolve to unknown venue risk; add a reviewed registry entry or alias.`;
  return {
    id: queueId("venue-risk-config-missing", missing.project),
    kind: "venue-risk-config-missing" as const,
    title: missing.project,
    detail,
    actionHint: "accept" as const,
    project: missing.project,
    poolCount: missing.poolCount,
    totalTvlUsd: missing.totalTvlUsd,
    protocolCategory: missing.protocolCategory,
    examplePools: missing.examplePools,
    examplePoolDetails: missing.examplePoolDetails,
    sourceLinks: missing.sourceLinks,
    ...(missing.stablecoinIds?.length ? { stablecoinIds: missing.stablecoinIds } : {}),
    ...(missing.sourceKeys?.length ? { sourceKey: missing.sourceKeys[0] } : {}),
  };
}

const CURATED_PIN_REGISTRY_LABEL: Record<CuratedPinRegistry, string> = {
  "native-pool": "Curated native pool pin",
  "variant-pool": "Curated variant pin",
  "weighted-pool-group": "Curated weighted pool group",
};

function buildDeadCuratedPinQueueItem(pin: DeadCuratedPin): CoverageAuditQueueItem {
  const coverageDetail = pin.coverage === "coverage-outage"
    ? "the asset publishes no ranking row"
    : pin.coverage === "dead-config"
      ? "the asset still publishes through another source"
      : "published coverage was not checked";
  return {
    id: queueId("stale-auto-lending-override", `${pin.stablecoinId}:${pin.pin}`),
    kind: "stale-auto-lending-override" as const,
    title: pin.stablecoinId,
    detail: `${CURATED_PIN_REGISTRY_LABEL[pin.registry]} ${pin.pin} is absent from the DeFiLlama snapshot; ${coverageDetail}.`,
    actionHint: "accept" as const,
    stablecoinIds: [pin.stablecoinId],
    pool: pin.pin,
    reasonCodes: [...pin.reasons, ...(pin.coverage ? [pin.coverage] : [])],
  };
}

export function buildCoverageAuditOperatorQueue({
  gaps,
  manifestMissingIds,
  yieldBearingMissingFromRankings,
  staleAutoLendingOverrides = [],
  deadCuratedPins = [],
  quarantineReadyToRestore = [],
  nowMs = Date.now(),
  staleVenueRiskScores = findStaleVenueRiskScores(nowMs),
}: {
  gaps: CoverageGaps;
  manifestMissingIds: string[];
  yieldBearingMissingFromRankings: string[];
  staleAutoLendingOverrides?: StaleAutoLendingOverride[];
  deadCuratedPins?: DeadCuratedPin[];
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
    ...deadCuratedPins.map(buildDeadCuratedPinQueueItem),
    ...gaps.unmatchedHighTvlPools.map((pool) => buildPoolQueueItem("unmatched-high-tvl-pool", pool, "watch")),
    ...gaps.missingProtocols.map((pool) => buildPoolQueueItem("missing-protocol", pool, "watch")),
  ];

  const recommendationCandidates: CoverageAuditQueueItem[] = [
    ...gaps.nativeExactPoolRecommendations.map((group) => ({
      id: queueId("native-exact-pool", group.stablecoinIds.join("-")),
      kind: "native-exact-pool" as const,
      title: poolTitle(group),
      detail: `${group.poolCount} uncovered pool(s) on ${group.chains.join(", ")} for ${group.stablecoinIds.join(", ")}`,
      actionHint: "accept" as const,
      stablecoinIds: group.stablecoinIds,
      project: group.project,
      pool: group.pool,
      symbol: group.symbol,
      chain: group.chain,
      poolCount: group.poolCount,
      totalTvlUsd: group.totalTvlUsd,
      examplePools: group.poolIds,
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
 * Venue slug an operator still has to review for a published row: the published
 * venue when it carries no reviewed config, otherwise the venue the source-key
 * route table attributes to the row's prefix. Returns null when the row already
 * resolves to a reviewed venue or names no venue at all.
 */
function resolvePublishedVenueSlug(row: PublishedYieldVenueRow): string | null {
  const published = row.venueProtocol?.trim().toLowerCase();
  if (published) {
    return resolveReviewedYieldRiskConfig(published) == null ? published : null;
  }
  const routed = resolveYieldSourceKeyRoute(row.sourceKey)?.venueProtocol ?? null;
  if (routed == null) return null;
  return resolveReviewedYieldRiskConfig(routed) == null ? routed : null;
}

/**
 * A10: the DeFiLlama pool loop only sees venues that publish a DL pool, so
 * protocol-api, on-chain, linked-variant and supplemental venues never queued.
 * Published rows above the high-TVL floor carry the same registry gap.
 */
function buildPublishedVenueRiskConfigMissing(
  rows: readonly PublishedYieldVenueRow[],
): VenueRiskConfigMissing[] {
  const byVenue = new Map<string, { rows: PublishedYieldVenueRow[]; totalTvlUsd: number }>();
  for (const row of rows) {
    const tvlUsd = row.sourceTvlUsd;
    if (tvlUsd == null || !Number.isFinite(tvlUsd) || tvlUsd < HIGH_TVL_THRESHOLD_USD) continue;
    const venue = resolvePublishedVenueSlug(row);
    if (venue == null) continue;
    const entry = byVenue.get(venue) ?? { rows: [], totalTvlUsd: 0 };
    entry.rows.push(row);
    entry.totalTvlUsd += tvlUsd;
    byVenue.set(venue, entry);
  }

  return [...byVenue.entries()]
    .map(([project, entry]) => ({
      project,
      protocolCategory: null,
      poolCount: entry.rows.length,
      totalTvlUsd: entry.totalTvlUsd,
      examplePools: [],
      examplePoolDetails: [],
      sourceLinks: [],
      stablecoinIds: [...new Set(entry.rows.map((row) => row.stablecoinId))].sort(),
      sourceKeys: [...new Set(entry.rows.flatMap((row) => (row.sourceKey ? [row.sourceKey] : [])))].sort(),
    }))
    .sort((a, b) => b.totalTvlUsd - a.totalTvlUsd)
    .slice(0, OPERATOR_QUEUE_ITEM_LIMIT);
}

/**
 * Pure function: given a list of DL pools and the exact DL pool IDs already
 * covered by Pharos, returns coverage gaps.
 *
 * Every pool id lands in at most one of the three pool-backed queue buckets
 * (`nativeExactPoolRecommendations`, `unmatchedHighTvlPools`, `missingProtocols`):
 * the native-pool candidate is the most specific action, the remaining high-TVL
 * pools route on DeFiLlama protocol category, and a routed protocol contributes
 * one representative pool instead of one row per pool.
 *
 * @param dlPools       - Full list of DL stablecoin pools.
 * @param coveredPools  - Set of exact covered DL pool UUIDs.
 */
export function identifyCoverageGaps(
  dlPools: DlPool[],
  coveredPools: Set<string>,
  supportedProtocols: Set<string> = LENDING_PROTOCOL_ALLOWLIST,
  protocolCategoriesByProject: Map<string, string> = new Map(),
  options: IdentifyCoverageGapsOptions = {},
): CoverageGaps {
  const highTvlUnsupportedPools: CoverageGapPool[] = [];
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
      highTvlUnsupportedPools.push(poolEntry);
    }
  }

  // Native candidates are keyed per tracked asset, not per pool: a multi-chain
  // deployment is one decision. A non-positive or non-finite APY carries no
  // opportunity, and an asset that already publishes a ranking row is covered
  // by another source.
  const yieldBearingIdsBySymbol = buildYieldBearingSymbolIndex();
  const publishedStablecoinIds = options.publishedStablecoinIds ?? new Set<string>();
  const nativeGroups = new Map<string, { stablecoinIds: string[]; pools: CoverageGapPool[] }>();
  for (const pool of uncoveredStablecoinPools) {
    if (pool.tvlUsd < HIGH_TVL_THRESHOLD_USD) continue;
    if (!Number.isFinite(pool.apy) || pool.apy <= 0) continue;
    const resolvedIds = yieldBearingIdsBySymbol.get(normalizeRecommendationSymbol(pool.symbol)) ?? [];
    const stablecoinIds = resolvedIds.filter((id) => !publishedStablecoinIds.has(id));
    if (stablecoinIds.length === 0) continue;
    const groupKey = stablecoinIds.join("|");
    const group = nativeGroups.get(groupKey) ?? { stablecoinIds, pools: [] };
    group.pools.push(pool);
    nativeGroups.set(groupKey, group);
  }
  const nativeExactPoolRecommendations: NativeExactPoolRecommendation[] = [...nativeGroups.values()]
    .map(({ stablecoinIds, pools }) => {
      const sortedPools = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd);
      return {
        ...sortedPools[0],
        stablecoinIds,
        poolIds: sortedPools.map((pool) => pool.pool),
        chains: [...new Set(sortedPools.map((pool) => pool.chain))],
        poolCount: sortedPools.length,
        totalTvlUsd: sortedPools.reduce((total, pool) => total + pool.tvlUsd, 0),
      };
    })
    .sort((a, b) => b.totalTvlUsd - a.totalTvlUsd)
    .slice(0, NATIVE_EXACT_POOL_GROUP_LIMIT);

  // C7: one pool, one bucket. Native candidates claim their pools first; the
  // rest route on category, because a known non-lending protocol cannot be
  // fixed by a lending-allowlist entry while an unclassified one still can.
  const claimedPoolIds = new Set(nativeExactPoolRecommendations.flatMap((group) => group.poolIds));
  const unmatchedHighTvlPools: CoverageGapPool[] = [];
  const missingProtocolByProject = new Map<string, CoverageGapPool>();
  for (const pool of highTvlUnsupportedPools) {
    if (claimedPoolIds.has(pool.pool)) continue;
    // Source-family projects carry their own `source-family-adapter` candidates.
    if (SOURCE_FAMILY_ADAPTER_PROJECTS.has(pool.project)) continue;
    if (pool.protocolCategory == null || isHighConfidenceProtocolCategory(pool.protocolCategory)) {
      unmatchedHighTvlPools.push(pool);
      continue;
    }
    const representative = missingProtocolByProject.get(pool.project);
    if (!representative || pool.tvlUsd > representative.tvlUsd) {
      missingProtocolByProject.set(pool.project, pool);
    }
  }
  const missingProtocols = [...missingProtocolByProject.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
  unmatchedHighTvlPools.sort((a, b) => b.tvlUsd - a.tvlUsd);

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
  const poolDerivedVenueCandidates = buildVenueRiskConfigMissing(venueRiskConfigMissingPools);
  const poolDerivedVenueProjects = new Set(
    poolDerivedVenueCandidates.map((candidate) => normalizeProtocolProjectKey(candidate.project)),
  );
  const publishedVenueCandidates = buildPublishedVenueRiskConfigMissing(options.publishedVenueRows ?? []);
  const publishedVenueByProject = new Map(
    publishedVenueCandidates.map((candidate) => [normalizeProtocolProjectKey(candidate.project), candidate]),
  );
  // SRC-SUPP-4: a project can be both a covered pool and a published-row venue.
  // First-wins filtering dropped the row-derived attribution — the publishing
  // assets and their unreviewed source keys — from such a project, so the two
  // views merge instead: the pool aggregation keeps the examples and the
  // published rows contribute the asset ids and source keys.
  const venueRiskConfigMissing = [
    ...poolDerivedVenueCandidates.map((candidate) => {
      const published = publishedVenueByProject.get(normalizeProtocolProjectKey(candidate.project));
      return published == null
        ? candidate
        : {
            ...candidate,
            stablecoinIds: published.stablecoinIds,
            sourceKeys: published.sourceKeys,
          };
    }),
    ...publishedVenueCandidates.filter(
      (candidate) => !poolDerivedVenueProjects.has(normalizeProtocolProjectKey(candidate.project)),
    ),
  ];

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
      stablecoinSupplyMapState: "ok",
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
 * B20: curated pins resolve silently — a missing DeFiLlama pool falls through
 * with a log line and no queue item, so a dead pin can zero an asset's yield
 * coverage for months. This walks every curated pin registry against the loaded
 * snapshot and cross-references the published rankings, so a dead config is
 * distinguishable from a live coverage outage.
 */
export function identifyDeadCuratedPins(
  dlPools: DlPool[],
  options: IdentifyDeadCuratedPinsOptions = {},
): DeadCuratedPin[] {
  const snapshotPoolIds = new Set(dlPools.map((pool) => pool.pool));
  const publishedStablecoinIds = options.publishedStablecoinIds;
  const classifyCoverage = (stablecoinId: string): DeadCuratedPin["coverage"] => {
    if (publishedStablecoinIds == null) return null;
    return publishedStablecoinIds.has(stablecoinId) ? "dead-config" : "coverage-outage";
  };
  const pins: DeadCuratedPin[] = [];

  for (const [stablecoinId, poolId] of Object.entries(YIELD_POOL_MAP)) {
    if (snapshotPoolIds.has(poolId)) continue;
    pins.push({
      stablecoinId,
      registry: "native-pool",
      pin: poolId,
      missingPoolIds: [poolId],
      presentPoolIds: [],
      reasons: ["missing-pool"],
      coverage: classifyCoverage(stablecoinId),
    });
  }

  for (const [stablecoinId, variant] of Object.entries(YIELD_VARIANT_MAP)) {
    const variantSymbol = normalizeDexSymbol(variant.variantSymbol);
    const variantChain = variant.variantChain ? normalizeChainId(variant.variantChain) : null;
    const variantProject = variant.variantProject?.trim().toLowerCase() ?? "";
    // Mirrors the runtime variant layer: single-exposure pools, optional chain
    // and project scoping, normalized symbol equality. An address hit is a
    // subset of the symbol candidates, so symbol resolution is the live gate.
    const resolvesToPool = dlPools.some((pool) =>
      pool.exposure === "single" &&
      normalizeDexSymbol(pool.symbol) === variantSymbol &&
      (!variantChain || normalizeChainId(pool.chain) === variantChain) &&
      (!variantProject || pool.project.trim().toLowerCase() === variantProject));
    if (resolvesToPool) continue;
    pins.push({
      stablecoinId,
      registry: "variant-pool",
      pin: variant.variantChain
        ? `${variant.variantSymbol} on ${variant.variantChain}`
        : variant.variantSymbol,
      missingPoolIds: [],
      presentPoolIds: [],
      reasons: ["missing-pool"],
      coverage: classifyCoverage(stablecoinId),
    });
  }

  for (const [stablecoinId, group] of Object.entries(YIELD_WEIGHTED_POOL_GROUPS)) {
    const missingPoolIds = group.poolIds.filter((poolId) => !snapshotPoolIds.has(poolId));
    if (missingPoolIds.length === 0) continue;
    pins.push({
      stablecoinId,
      registry: "weighted-pool-group",
      pin: missingPoolIds[0],
      missingPoolIds,
      presentPoolIds: group.poolIds.filter((poolId) => snapshotPoolIds.has(poolId)),
      reasons: ["missing-pool"],
      coverage: classifyCoverage(stablecoinId),
    });
  }

  return pins.sort((a, b) =>
    a.stablecoinId.localeCompare(b.stablecoinId) || a.pin.localeCompare(b.pin));
}
