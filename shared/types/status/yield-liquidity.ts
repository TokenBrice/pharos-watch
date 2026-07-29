import type { LiquidityCoverageClass } from "../market";
import type { MintBurnCoverageStatus } from "../mint-burn";
import type { StatusHealthOrUnknown } from "./core";

export interface LiquidityHealth {
  lastRunStatus: string | null;
  currentCoverage: number;
  previousCoverage: number | null;
  currentGlobalTvl: number | null;
  previousGlobalTvl: number | null;
  currentTop10CoveredTvl: number | null;
  previousTop10CoveredTvl: number | null;
  currentTop10GuardTvl: number | null;
  previousTop10GuardTvl: number | null;
  failedSources: string[];
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  currentCoverageClasses: Record<LiquidityCoverageClass, number>;
  previousCoverageClasses: Record<LiquidityCoverageClass, number>;
}

export type YieldHealthFieldStatus = StatusHealthOrUnknown;

export type YieldSourceRiskCoverageField =
  | "sourceRiskScore"
  | "sourceRiskPenalty"
  | "sourceDepthRatio"
  | "rewardShare"
  | "sourceAgeSeconds"
  | "observationCount30d"
  | "sourceSwitchCount30d"
  | "deploymentPlace"
  | "venueProtocol"
  | "venueChain"
  | "venueRiskTier";

export interface YieldSourceRiskFieldCoverage {
  eligibleCount: number;
  populatedCount: number;
  nullCount: number;
  coverageRatio: number;
  nullRate: number;
}

export interface YieldSourceRiskCoverageSummary {
  status: YieldHealthFieldStatus;
  threshold: number;
  totalRows: number;
  bestRows: number;
  altRows: number;
  rowsWithSourceRisk: number;
  fields: Record<YieldSourceRiskCoverageField, YieldSourceRiskFieldCoverage>;
}

interface YieldComparisonAnchorFreshnessExample {
  stablecoinId: string;
  symbol: string;
  sourceKey: string;
  dataSource: string;
  anchorAgeSeconds: number;
  comparisonAnchorObservedAt: number;
}

interface YieldComparisonAnchorFreshnessSummary {
  status: YieldHealthFieldStatus;
  anchoredRowCount: number | null;
  staleAnchorCount: number | null;
  oldestAnchorAgeSeconds: number | null;
  oldestAnchorStablecoinId: string | null;
  oldestAnchorSourceKey: string | null;
  staleAnchorExamples: YieldComparisonAnchorFreshnessExample[];
  staleAnchorExamplesTruncated: boolean;
}

interface YieldBenchmarkHealthEntry {
  key: string;
  label: string | null;
  currency: string | null;
  rowCount: number;
  fallbackSelectionRowCount: number;
  fetchedAt: number | null;
  ageSec: number | null;
  maxAgeSec: number;
  source: string | null;
  isFallback: boolean | null;
  fallbackMode: string | null;
  status: YieldHealthFieldStatus;
}

interface YieldBenchmarkRegistryHealthSummary {
  status: YieldHealthFieldStatus;
  usedBenchmarkCount: number;
  healthyBenchmarkCount: number;
  degradedBenchmarkCount: number;
  staleBenchmarkCount: number;
  unknownBenchmarkCount: number;
  benchmarks: Record<string, YieldBenchmarkHealthEntry>;
}

export type YieldCoverageAuditQueueAction = "accept" | "dismiss" | "intentional-gap" | "watch";

export type YieldCoverageAuditQueueItemKind =
  | "manifest-missing"
  | "ranking-missing"
  | "unmatched-high-tvl-pool"
  | "missing-protocol"
  | "native-exact-pool"
  | "source-family-adapter"
  | "lending-allowlist"
  | "venue-risk-config-missing"
  | "stale-auto-lending-override"
  | "quarantine-ready-to-restore"
  | "stale-venue-risk-score";

export interface YieldCoverageAuditQueueItem {
  id: string;
  kind: YieldCoverageAuditQueueItemKind;
  title: string;
  detail: string;
  actionHint: YieldCoverageAuditQueueAction;
  stablecoinIds?: string[];
  project?: string;
  pool?: string;
  symbol?: string;
  chain?: string;
  tvlUsd?: number;
  apy?: number;
  poolCount?: number;
  totalTvlUsd?: number;
  recommendedTier?: "high-confidence" | "review-needed";
}

export interface YieldHealthSummary {
  status: Exclude<YieldHealthFieldStatus, "unknown">;
  statusImpact: "public-critical" | "admin-watch";
  runbookUrl: string;
  rankingCount: number | null;
  rankingCountDelta: number | null;
  previousRankingCount: number | null;
  rankingUpdatedAt: number | null;
  rankingAgeSec: number | null;
  rankingMaxAgeSec: number;
  rankingStatus: YieldHealthFieldStatus;
  safetyCoverage: {
    coveredCount: number | null;
    trackedCount: number | null;
    coverageRatio: number | null;
    threshold: number;
    status: YieldHealthFieldStatus;
    reason: string | null;
  };
  supplemental: {
    updatedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    status: YieldHealthFieldStatus;
    familyCount?: number;
    freshFamilyCount?: number;
    degradedFamilyCount?: number;
    staleFamilyCount?: number;
    missingFamilyCount?: number;
    families?: Record<
      string,
      {
        updatedAt: number | null;
        ageSec: number | null;
        sourceCount: number | null;
        status: YieldHealthFieldStatus;
      }
    >;
  };
  benchmark: {
    fetchedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    source: string | null;
    isFallback: boolean | null;
    fallbackMode: string | null;
    status: YieldHealthFieldStatus;
  };
  benchmarkRegistry: YieldBenchmarkRegistryHealthSummary;
  coverageAudit: {
    updatedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    status: YieldHealthFieldStatus;
    headlineGapCount: number | null;
    recommendationCandidateCount: number | null;
    manifestMissingCount: number | null;
    yieldBearingMissingFromRankingsCount: number | null;
    unmatchedHighTvlPoolCount: number | null;
    missingProtocolCount: number | null;
    nativeExactPoolRecommendationCount: number | null;
    sourceFamilyAdapterRecommendationCount: number | null;
    lendingAllowlistRecommendationCount: number | null;
    venueRiskConfigMissingCount: number | null;
    staleAutoLendingOverrideCount: number | null;
    staleVenueRiskScoreCount: number | null;
    headlineGaps: YieldCoverageAuditQueueItem[];
    recommendationCandidates: YieldCoverageAuditQueueItem[];
    allowedActions: YieldCoverageAuditQueueAction[];
    queuePersistence: "deferred" | "durable";
  };
  sourceRiskCoverage: YieldSourceRiskCoverageSummary;
  comparisonAnchorFreshness: YieldComparisonAnchorFreshnessSummary;
  latestCronStatus: string | null;
  latestCronStartedAt: number | null;
}

export interface MintBurnReconciliationRow {
  stablecoinId: string;
  symbol: string;
  flowNet24hUsd: number;
  chainSupplyDelta24hUsd: number | null;
  absoluteDiffUsd: number | null;
  diffRatio: number | null;
  status: "ok" | "warn" | "critical" | "insufficient-source";
  coverageStatus: MintBurnCoverageStatus | "unknown";
}

export interface MintBurnReconciliationSummary {
  checkedAt: number;
  comparedCoins: number;
  criticalCount: number;
  warnCount: number;
  insufficientCount: number;
  rows: MintBurnReconciliationRow[];
}

export interface ReserveDriftEntry {
  coinId: string;
  liveCollateralScore: number;
  curatedCollateralScore: number;
  delta: number;
}

export interface ClassificationWarning {
  coinId: string;
  governance: string;
  centralizedCustodyPct: number;
  threshold: number;
}

interface CoinGeckoPriceDiffRow {
  stablecoinId: string;
  symbol: string;
  name: string;
  geckoId: string;
  ourPrice: number;
  coinGeckoPrice: number;
  diffPct: number;
  priceSource: string;
  priceConfidence: string | null;
}

export interface CoinGeckoPriceDiff {
  checkedAt: number;
  trackedWithGeckoId: number;
  comparedCoins: number;
  mismatchedCount: number;
  thresholdPct: number;
  rows: CoinGeckoPriceDiffRow[];
}
