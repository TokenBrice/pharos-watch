import { z } from "zod";
import { LiquidityCoverageClassSchema } from "../market";
import { MintBurnCoverageStatusSchema } from "../mint-burn";
import { StatusHealthValueSchema } from "./core";
import type { StatusHealthOrUnknown } from "./core";
import { StatusHealthOrUnknownSchema } from "./schema-primitives";

export const LiquidityHealthSchema = z.object({
  lastRunStatus: z.string().nullable(),
  currentCoverage: z.number(),
  previousCoverage: z.number().nullable(),
  currentGlobalTvl: z.number().nullable(),
  previousGlobalTvl: z.number().nullable(),
  currentTop10CoveredTvl: z.number().nullable(),
  previousTop10CoveredTvl: z.number().nullable(),
  currentTop10GuardTvl: z.number().nullable(),
  previousTop10GuardTvl: z.number().nullable(),
  failedSources: z.array(z.string()),
  nearCoverageGuard: z.boolean(),
  nearValueGuard: z.boolean(),
  nearMajorCoverageGuard: z.boolean(),
  currentCoverageClasses: z.record(LiquidityCoverageClassSchema, z.number()),
  previousCoverageClasses: z.record(LiquidityCoverageClassSchema, z.number()),
});
export type LiquidityHealth = z.output<typeof LiquidityHealthSchema>;

export type YieldHealthFieldStatus = StatusHealthOrUnknown;

export const YIELD_SOURCE_RISK_COVERAGE_FIELDS = [
  "sourceRiskScore",
  "sourceRiskPenalty",
  "sourceDepthRatio",
  "rewardShare",
  "sourceAgeSeconds",
  "observationCount30d",
  "sourceSwitchCount30d",
  "deploymentPlace",
  "venueProtocol",
  "venueChain",
  "venueRiskTier",
] as const;
export type YieldSourceRiskCoverageField = (typeof YIELD_SOURCE_RISK_COVERAGE_FIELDS)[number];

const YieldSourceRiskCoverageFieldSchema = z.enum(YIELD_SOURCE_RISK_COVERAGE_FIELDS);

export const YieldSourceRiskFieldCoverageSchema = z.object({
  /** Rows on which this field can exist at all (A7 per-field eligibility). */
  eligibleCount: z.number(),
  populatedCount: z.number(),
  nullCount: z.number(),
  /** `null` when no row is eligible: absent evidence never reads as full coverage. */
  coverageRatio: z.number().nullable(),
  nullRate: z.number().nullable(),
  /** Rows excluded from the denominator because the field cannot exist for them. */
  ineligibleCount: z.number().optional(),
  bestEligibleCount: z.number().optional(),
  bestPopulatedCount: z.number().optional(),
  bestCoverageRatio: z.number().nullable().optional(),
  altEligibleCount: z.number().optional(),
  altPopulatedCount: z.number().optional(),
  altCoverageRatio: z.number().nullable().optional(),
});
export type YieldSourceRiskFieldCoverage = z.output<typeof YieldSourceRiskFieldCoverageSchema>;

export const YieldSourceRiskCoverageSummarySchema = z.object({
  status: StatusHealthOrUnknownSchema,
  threshold: z.number(),
  totalRows: z.number(),
  bestRows: z.number(),
  altRows: z.number(),
  rowsWithSourceRisk: z.number(),
  fields: z.record(YieldSourceRiskCoverageFieldSchema, YieldSourceRiskFieldCoverageSchema),
});
export type YieldSourceRiskCoverageSummary = z.output<typeof YieldSourceRiskCoverageSummarySchema>;

const YieldComparisonAnchorFreshnessExampleSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  sourceKey: z.string(),
  dataSource: z.string(),
  anchorAgeSeconds: z.number(),
  comparisonAnchorObservedAt: z.number(),
});

const YieldComparisonAnchorFreshnessSummarySchema = z.object({
  status: StatusHealthOrUnknownSchema,
  anchoredRowCount: z.number().nullable(),
  staleAnchorCount: z.number().nullable(),
  oldestAnchorAgeSeconds: z.number().nullable(),
  oldestAnchorStablecoinId: z.string().nullable(),
  oldestAnchorSourceKey: z.string().nullable(),
  staleAnchorExamples: z.array(YieldComparisonAnchorFreshnessExampleSchema),
  staleAnchorExamplesTruncated: z.boolean(),
});

const YieldBenchmarkHealthEntrySchema = z.object({
  key: z.string(),
  label: z.string().nullable(),
  currency: z.string().nullable(),
  rowCount: z.number(),
  /** Rows that substituted this key for a peg with no native feed. */
  fallbackSelectionRowCount: z.number(),
  /** Rows whose benchmark is a documented proxy selection, not a feed incident (A1). */
  proxySelectionRowCount: z.number().optional(),
  fetchedAt: z.number().nullable(),
  ageSec: z.number().nullable(),
  maxAgeSec: z.number(),
  recordDate: z.string().nullable().optional(),
  recordAgeSec: z.number().nullable().optional(),
  maxRecordAgeSec: z.number().nullable().optional(),
  source: z.string().nullable(),
  isFallback: z.boolean().nullable(),
  fallbackMode: z.string().nullable(),
  status: StatusHealthOrUnknownSchema,
});

const YieldUnusedBenchmarkKeySchema = z.object({
  key: z.string(),
  source: z.string().nullable(),
  recordDate: z.string().nullable(),
  recordAgeSec: z.number().nullable(),
  ageSec: z.number().nullable(),
});

const YieldBenchmarkRegistryHealthSummarySchema = z.object({
  status: StatusHealthOrUnknownSchema,
  usedBenchmarkCount: z.number(),
  healthyBenchmarkCount: z.number(),
  degradedBenchmarkCount: z.number(),
  staleBenchmarkCount: z.number(),
  unknownBenchmarkCount: z.number(),
  benchmarks: z.record(z.string(), YieldBenchmarkHealthEntrySchema),
  /** Fetched keys no published row uses: monitored, but never status-bearing (A6). */
  unusedBenchmarkKeys: z.array(YieldUnusedBenchmarkKeySchema).optional(),
  /** Benchmark keys published by rows that the registry does not define (A6). */
  unknownKeys: z.array(z.string()).optional(),
  unknownKeyRowCount: z.number().optional(),
});

export const YIELD_COVERAGE_AUDIT_QUEUE_ACTIONS = [
  "accept",
  "dismiss",
  "intentional-gap",
  "watch",
] as const;
export type YieldCoverageAuditQueueAction = (typeof YIELD_COVERAGE_AUDIT_QUEUE_ACTIONS)[number];

export const YIELD_COVERAGE_AUDIT_QUEUE_ITEM_KINDS = [
  "manifest-missing",
  "ranking-missing",
  "unmatched-high-tvl-pool",
  "missing-protocol",
  "native-exact-pool",
  "source-family-adapter",
  "lending-allowlist",
  "venue-risk-config-missing",
  "stale-auto-lending-override",
  "quarantine-ready-to-restore",
  "stale-venue-risk-score",
] as const;
export type YieldCoverageAuditQueueItemKind = (typeof YIELD_COVERAGE_AUDIT_QUEUE_ITEM_KINDS)[number];

export const YieldCoverageAuditQueueItemSchema = z.object({
  id: z.string(),
  kind: z.enum(YIELD_COVERAGE_AUDIT_QUEUE_ITEM_KINDS),
  title: z.string(),
  detail: z.string(),
  actionHint: z.enum(YIELD_COVERAGE_AUDIT_QUEUE_ACTIONS),
  stablecoinIds: z.array(z.string()).optional(),
  project: z.string().optional(),
  pool: z.string().optional(),
  symbol: z.string().optional(),
  chain: z.string().optional(),
  tvlUsd: z.number().optional(),
  apy: z.number().optional(),
  poolCount: z.number().optional(),
  totalTvlUsd: z.number().optional(),
  recommendedTier: z.enum(["high-confidence", "review-needed"]).optional(),
});
export type YieldCoverageAuditQueueItem = z.output<typeof YieldCoverageAuditQueueItemSchema>;

export const YieldHealthSummarySchema = z.object({
  status: StatusHealthValueSchema,
  statusImpact: z.enum(["public-critical", "admin-watch"]),
  runbookUrl: z.string(),
  rankingCount: z.number().nullable(),
  rankingCountDelta: z.number().nullable(),
  previousRankingCount: z.number().nullable(),
  rankingUpdatedAt: z.number().nullable(),
  rankingAgeSec: z.number().nullable(),
  rankingMaxAgeSec: z.number(),
  rankingStatus: StatusHealthOrUnknownSchema,
  safetyCoverage: z.object({
    coveredCount: z.number().nullable(),
    trackedCount: z.number().nullable(),
    coverageRatio: z.number().nullable(),
    threshold: z.number(),
    status: StatusHealthOrUnknownSchema,
    reason: z.string().nullable(),
  }),
  supplemental: z.object({
    updatedAt: z.number().nullable(),
    ageSec: z.number().nullable(),
    maxAgeSec: z.number(),
    status: StatusHealthOrUnknownSchema,
    familyCount: z.number().optional(),
    freshFamilyCount: z.number().optional(),
    degradedFamilyCount: z.number().optional(),
    staleFamilyCount: z.number().optional(),
    missingFamilyCount: z.number().optional(),
    /**
     * SRC-SUPP-1: families the producer's run-outcome row
     * (`yield:supplemental-source-run:v1`) named as degraded, i.e. whose fetch
     * ended early and whose previous snapshot was kept. A family listed here is
     * never classified healthier than `degraded`.
     */
    degradedFamilies: z.array(z.string()).optional(),
    families: z.record(
      z.string(),
      z.object({
        updatedAt: z.number().nullable(),
        ageSec: z.number().nullable(),
        sourceCount: z.number().nullable(),
        status: StatusHealthOrUnknownSchema,
        /** True when this row is the retained snapshot from the last degraded fetch. */
        retained: z.boolean().optional(),
      }),
    ).optional(),
  }),
  benchmark: z.object({
    fetchedAt: z.number().nullable(),
    ageSec: z.number().nullable(),
    maxAgeSec: z.number(),
    source: z.string().nullable(),
    isFallback: z.boolean().nullable(),
    fallbackMode: z.string().nullable(),
    status: StatusHealthOrUnknownSchema,
  }),
  benchmarkRegistry: YieldBenchmarkRegistryHealthSummarySchema,
  coverageAudit: z.object({
    updatedAt: z.number().nullable(),
    ageSec: z.number().nullable(),
    maxAgeSec: z.number(),
    status: StatusHealthOrUnknownSchema,
    headlineGapCount: z.number().nullable(),
    recommendationCandidateCount: z.number().nullable(),
    manifestMissingCount: z.number().nullable(),
    yieldBearingMissingFromRankingsCount: z.number().nullable(),
    unmatchedHighTvlPoolCount: z.number().nullable(),
    missingProtocolCount: z.number().nullable(),
    nativeExactPoolRecommendationCount: z.number().nullable(),
    sourceFamilyAdapterRecommendationCount: z.number().nullable(),
    lendingAllowlistRecommendationCount: z.number().nullable(),
    venueRiskConfigMissingCount: z.number().nullable(),
    staleAutoLendingOverrideCount: z.number().nullable(),
    staleVenueRiskScoreCount: z.number().nullable(),
    headlineGaps: z.array(YieldCoverageAuditQueueItemSchema),
    recommendationCandidates: z.array(YieldCoverageAuditQueueItemSchema),
    allowedActions: z.array(z.enum(YIELD_COVERAGE_AUDIT_QUEUE_ACTIONS)),
    queuePersistence: z.enum(["deferred", "durable"]),
    /** Whole-queue accounting from the producer: per-kind counts, suppression, truncation (C8). */
    queueTotals: z.object({
      byKind: z.record(z.string(), z.number()),
      suppressedItemCount: z.number(),
      truncated: z.boolean(),
    }).nullable().optional(),
    /** Documented drain budget the queue backlog is measured against (C4). */
    queueBudget: z.object({
      headlineGaps: z.number(),
      recommendationCandidates: z.number(),
    }).optional(),
    /** The rendered queue performs no writes until the admin disposition route lands (C8). */
    queueDisplayOnly: z.boolean().optional(),
  }),
  sourceRiskCoverage: YieldSourceRiskCoverageSummarySchema,
  comparisonAnchorFreshness: YieldComparisonAnchorFreshnessSummarySchema,
  latestCronStatus: z.string().nullable(),
  latestCronStartedAt: z.number().nullable(),
  /** Read-time live-safety hydration state behind the publish-time snapshot (C5). */
  liveSafetyHydration: z.object({
    status: StatusHealthOrUnknownSchema,
    reason: z.string().nullable(),
    fallback: z.string().nullable(),
    staleCoherentMaxAgeSec: z.number(),
    cachedAgeSec: z.number().nullable(),
  }).optional(),
  /** `pys_inputs_at_publish` persistence from the latest publisher run (C3). */
  pysInputs: z.object({
    status: StatusHealthOrUnknownSchema,
    persistedCount: z.number().nullable(),
    nullCount: z.number().nullable(),
    nullRate: z.number().nullable(),
    threshold: z.number(),
  }).optional(),
});
export type YieldHealthSummary = z.output<typeof YieldHealthSummarySchema>;

export const MintBurnReconciliationRowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  flowNet24hUsd: z.number(),
  chainSupplyDelta24hUsd: z.number().nullable(),
  absoluteDiffUsd: z.number().nullable(),
  diffRatio: z.number().nullable(),
  status: z.enum(["ok", "warn", "critical", "insufficient-source"]),
  coverageStatus: z.union([MintBurnCoverageStatusSchema, z.literal("unknown")]),
});
export type MintBurnReconciliationRow = z.output<typeof MintBurnReconciliationRowSchema>;

export const MintBurnReconciliationSummarySchema = z.object({
  checkedAt: z.number(),
  comparedCoins: z.number(),
  criticalCount: z.number(),
  warnCount: z.number(),
  insufficientCount: z.number(),
  rows: z.array(MintBurnReconciliationRowSchema),
});
export type MintBurnReconciliationSummary = z.output<typeof MintBurnReconciliationSummarySchema>;

export const ReserveDriftEntrySchema = z.object({
  coinId: z.string(),
  liveCollateralScore: z.number(),
  curatedCollateralScore: z.number(),
  delta: z.number(),
});
export type ReserveDriftEntry = z.output<typeof ReserveDriftEntrySchema>;

export const ClassificationWarningSchema = z.object({
  coinId: z.string(),
  governance: z.string(),
  centralizedCustodyPct: z.number(),
  threshold: z.number(),
});
export type ClassificationWarning = z.output<typeof ClassificationWarningSchema>;

const CoinGeckoPriceDiffRowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  geckoId: z.string(),
  ourPrice: z.number(),
  coinGeckoPrice: z.number(),
  diffPct: z.number(),
  priceSource: z.string(),
  priceConfidence: z.string().nullable(),
});

export const CoinGeckoPriceDiffSchema = z.object({
  checkedAt: z.number(),
  trackedWithGeckoId: z.number(),
  comparedCoins: z.number(),
  mismatchedCount: z.number(),
  thresholdPct: z.number(),
  rows: z.array(CoinGeckoPriceDiffRowSchema),
});
export type CoinGeckoPriceDiff = z.output<typeof CoinGeckoPriceDiffSchema>;
