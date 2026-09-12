import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  getCacheRatioThresholds,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_YIELD_HEALTH_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import {
  YIELD_BENCHMARK_KEY_VALUES,
  type YieldBenchmarkKey,
} from "@shared/types/yield";
import type {
  CronStatus,
  YieldCoverageAuditQueueAction,
  YieldCoverageAuditQueueItem,
  YieldCoverageAuditQueueItemKind,
  YieldHealthFieldStatus,
  YieldHealthSummary,
  YieldSourceRiskCoverageField,
  YieldSourceRiskCoverageSummary,
} from "@shared/types/status";
import { getYieldSupplementalFamilyCacheKey } from "../../cron/yield-sync/cache";
import {
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "../../cron/yield-sync/supplemental-source-families";
import { getBoolean, getNumber, getObject, getString } from "../dews/source-state/legacy-bridge";
import { safeJsonParse } from "../api-cache-read";
import { loadSafetyScoreV9PublicationIdentityEnvelope } from "../safety-score-v9/publication-store";
import {
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
  YIELD_BENCHMARK_SCORE_TTL_SEC,
} from "../../cron/yield-sync/benchmarks";

const YIELD_RUNBOOK_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/yield-health.md";
const YIELD_RANKINGS_CACHE_KEY = "yield-rankings";
const YIELD_COVERAGE_AUDIT_CACHE_KEY = "yield-coverage-audit";
const YIELD_RANKING_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];
// ADR-9: the admin card classifies ranking age on the same bands the public
// `yield-data` availability rule uses, so /status/ and this card cannot disagree.
const YIELD_RANKING_RATIO_THRESHOLDS = getCacheRatioThresholds("yield-data");
const COVERAGE_AUDIT_QUEUE_ITEM_LIMIT = 6;
// One monthly audit cycle can absorb roughly this much triage; a backlog above
// it is growing faster than operators drain it, which is a status signal rather
// than a queue listing. Measured against the audit's own deduped kind counts.
const COVERAGE_AUDIT_QUEUE_BUDGET = {
  headlineGaps: 150,
  recommendationCandidates: 100,
} as const;
// Share of published rows allowed to lose their `pys_inputs_at_publish` evidence
// before the publisher's persistence is treated as degraded.
const PYS_INPUTS_NULL_RATE_BUDGET = 0.05;
// Lanes whose provider publishes an apyBase/apyReward split. Every other lane
// reports one undivided rate, so `rewardShare` cannot exist there unless the row
// itself carries an `apyReward` (A7).
const REWARD_SPLIT_CAPABLE_DATA_SOURCES: Record<string, boolean> = {
  defillama: true,
  "defillama-auto": true,
};
// Derivation methods where the asset is its own venue: no pool, no venue, so no
// depth ratio and no venue risk tier can exist (A7).
const ASSET_AS_VENUE_DATA_SOURCES: Record<string, boolean> = {
  "price-derived": true,
  "rate-derived": true,
};
const COVERAGE_AUDIT_QUEUE_ACTIONS = ["accept", "dismiss", "intentional-gap", "watch"] satisfies YieldCoverageAuditQueueAction[];
const COVERAGE_AUDIT_QUEUE_ITEM_KINDS = [
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
] satisfies YieldCoverageAuditQueueItemKind[];
const SOURCE_RISK_COVERAGE_FIELDS = [
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
] satisfies YieldSourceRiskCoverageField[];
const SOURCE_RISK_CORE_COVERAGE_FIELDS = [
  "sourceRiskPenalty",
  "rewardShare",
  "sourceAgeSeconds",
  "sourceDepthRatio",
  "venueRiskTier",
  "sourceRiskScore",
] satisfies YieldSourceRiskCoverageField[];

interface CacheRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

function safeJsonObjectParse(json: string | null | undefined, context: string): Record<string, unknown> | null {
  const parsed = safeJsonParse<unknown>(json, null, context);
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function ageSeconds(now: number, updatedAt: number | null | undefined): number | null {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt)
    ? Math.max(0, now - updatedAt)
    : null;
}

function recordAgeSeconds(now: number, recordDate: string | null): number | null {
  if (!recordDate) return null;
  const parsed = Date.parse(`${recordDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.max(0, now - Math.trunc(parsed / 1000)) : null;
}

function freshnessStatus(
  ageSec: number | null,
  maxAgeSec: number,
  options?: {
    missingIs?: YieldHealthFieldStatus;
    degradedAfterOne?: boolean;
    thresholds?: { degraded: number; stale: number };
  },
): YieldHealthFieldStatus {
  if (ageSec == null) return options?.missingIs ?? "unknown";
  const thresholds = options?.thresholds ?? STATUS_CACHE_RATIO_THRESHOLDS;
  const ratio = ageSec / maxAgeSec;
  if (ratio > thresholds.stale) return "stale";
  if (options?.degradedAfterOne && ageSec > maxAgeSec) return "degraded";
  if (ratio > thresholds.degraded) return "degraded";
  return "healthy";
}

function worstStatus(statuses: YieldHealthFieldStatus[]): Exclude<YieldHealthFieldStatus, "unknown"> {
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("degraded") || statuses.includes("unknown")) return "degraded";
  return "healthy";
}

function getStringArray(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : null;
}

function readComparisonAnchorExamples(value: unknown): YieldHealthSummary["comparisonAnchorFreshness"]["staleAnchorExamples"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = getObject(entry);
    const stablecoinId = getString(row?.stablecoinId);
    const symbol = getString(row?.symbol);
    const sourceKey = getString(row?.sourceKey);
    const dataSource = getString(row?.dataSource);
    const anchorAgeSeconds = getNumber(row?.anchorAgeSeconds);
    const comparisonAnchorObservedAt = getNumber(row?.comparisonAnchorObservedAt);
    return stablecoinId && symbol && sourceKey && dataSource && anchorAgeSeconds != null && comparisonAnchorObservedAt != null
      ? [{
          stablecoinId,
          symbol,
          sourceKey,
          dataSource,
          anchorAgeSeconds,
          comparisonAnchorObservedAt,
        }]
      : [];
  });
}

function buildComparisonAnchorFreshnessSummary(
  crons: Record<string, CronStatus>,
): YieldHealthSummary["comparisonAnchorFreshness"] {
  const sourceCoverage = getObject(crons["sync-yield-data"]?.lastRun?.metadata?.sourceCoverage);
  const summary = getObject(sourceCoverage?.comparisonAnchorFreshness);
  const staleAnchorCount = getNumber(summary?.staleAnchorCount);

  return {
    status: staleAnchorCount == null
      ? "unknown"
      : staleAnchorCount > 0
        ? "degraded"
        : "healthy",
    anchoredRowCount: getNumber(summary?.anchoredRowCount),
    staleAnchorCount,
    oldestAnchorAgeSeconds: getNumber(summary?.oldestAnchorAgeSeconds),
    oldestAnchorStablecoinId: getString(summary?.oldestAnchorStablecoinId),
    oldestAnchorSourceKey: getString(summary?.oldestAnchorSourceKey),
    staleAnchorExamples: readComparisonAnchorExamples(summary?.staleAnchorExamples),
    staleAnchorExamplesTruncated: getBoolean(summary?.staleAnchorExamplesTruncated) ?? false,
  };
}

function getSyncYieldDataMetadata(crons: Record<string, CronStatus>): Record<string, unknown> | null {
  return getObject(crons["sync-yield-data"]?.lastRun?.metadata);
}

function getSyncYieldRankingDeltaMetadata(crons: Record<string, CronStatus>): {
  previousRankingCount: number | null;
  rankingCountDelta: number | null;
} {
  const metadata = getSyncYieldDataMetadata(crons);
  const sourceCoverage = getObject(metadata?.sourceCoverage);
  return {
    previousRankingCount:
      getNumber(sourceCoverage?.previousPublishedRankingCount)
      ?? getNumber(metadata?.previousPublishedRankingCount),
    rankingCountDelta:
      getNumber(sourceCoverage?.publishedRankingCountDelta)
      ?? getNumber(metadata?.publishedRankingCountDelta),
  };
}

function getQueueAction(value: unknown): YieldCoverageAuditQueueAction {
  return COVERAGE_AUDIT_QUEUE_ACTIONS.includes(value as YieldCoverageAuditQueueAction)
    ? value as YieldCoverageAuditQueueAction
    : "watch";
}

function getQueueKind(value: unknown): YieldCoverageAuditQueueItemKind | null {
  return COVERAGE_AUDIT_QUEUE_ITEM_KINDS.includes(value as YieldCoverageAuditQueueItemKind)
    ? value as YieldCoverageAuditQueueItemKind
    : null;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function sourceRiskValuePopulated(field: YieldSourceRiskCoverageField, value: unknown): boolean {
  if (field === "venueRiskTier") {
    return value === "low" || value === "medium" || value === "high";
  }
  if (field === "deploymentPlace" || field === "venueProtocol" || field === "venueChain") {
    return typeof value === "string" && value.length > 0;
  }
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A penalty is evidenced only when at least two independent evidence families
 * back it (A11). A finite `sourceAgeSeconds` alone is published on every row,
 * so accepting it made the field a tautology that reported 100% unconditionally.
 */
function hasSourceRiskPenaltyEvidence(sourceRisk: Record<string, unknown> | null): boolean {
  if (!sourceRisk) return false;
  const families = [
    getNumber(sourceRisk.rewardShare) != null,
    getNumber(sourceRisk.sourceDepthRatio) != null,
    getNumber(sourceRisk.sourceAgeSeconds) != null,
    getNumber(sourceRisk.observationCount30d) != null || getNumber(sourceRisk.sourceSwitchCount30d) != null,
    sourceRisk.venueRiskTier === "low"
      || sourceRisk.venueRiskTier === "medium"
      || sourceRisk.venueRiskTier === "high",
  ];
  return families.filter(Boolean).length >= 2;
}

interface SourceRiskCoverageRow {
  sourceRisk: Record<string, unknown> | null;
  isBest: boolean;
  /** The asset is its own venue: no pool depth and no venue tier can exist. */
  assetIsVenue: boolean;
  /** The source publishes (or proves) an incentive split. */
  rewardSplitPossible: boolean;
}

function readSourceRiskCoverageRow(
  row: Record<string, unknown>,
  isBest: boolean,
): SourceRiskCoverageRow {
  const sourceRisk = getObject(row.sourceRisk);
  const dataSource = getString(row.dataSource) ?? "";
  const deploymentPlace = getString(sourceRisk?.deploymentPlace) ?? "";
  return {
    sourceRisk,
    isBest,
    assetIsVenue:
      ASSET_AS_VENUE_DATA_SOURCES[dataSource] === true
      || ASSET_AS_VENUE_DATA_SOURCES[deploymentPlace] === true,
    rewardSplitPossible:
      REWARD_SPLIT_CAPABLE_DATA_SOURCES[dataSource] === true || getNumber(row.apyReward) != null,
  };
}

function sourceRiskRowEligible(field: YieldSourceRiskCoverageField, row: SourceRiskCoverageRow): boolean {
  if (field === "sourceSwitchCount30d") return row.isBest;
  if (field === "sourceDepthRatio" || field === "venueRiskTier") return !row.assetIsVenue;
  if (field === "rewardShare") return row.rewardSplitPossible;
  return true;
}

function sourceRiskFieldPopulated(field: YieldSourceRiskCoverageField, row: SourceRiskCoverageRow): boolean {
  if (!sourceRiskValuePopulated(field, row.sourceRisk?.[field])) return false;
  return field !== "sourceRiskPenalty" || hasSourceRiskPenaltyEvidence(row.sourceRisk);
}

function buildSourceRiskCoverage(rankings: unknown[] | null): YieldSourceRiskCoverageSummary {
  const sourceRows: SourceRiskCoverageRow[] = [];

  for (const ranking of rankings ?? []) {
    const row = getObject(ranking);
    if (!row) continue;
    sourceRows.push(readSourceRiskCoverageRow(row, true));

    if (Array.isArray(row.altSources)) {
      for (const alt of row.altSources) {
        const altRow = getObject(alt);
        if (!altRow) continue;
        sourceRows.push(readSourceRiskCoverageRow(altRow, false));
      }
    }
  }

  const fields = Object.fromEntries(
    SOURCE_RISK_COVERAGE_FIELDS.map((field) => {
      const eligibleRows = sourceRows.filter((row) => sourceRiskRowEligible(field, row));
      const populatedRows = eligibleRows.filter((row) => sourceRiskFieldPopulated(field, row));
      const bestEligible = eligibleRows.filter((row) => row.isBest);
      const bestPopulated = populatedRows.filter((row) => row.isBest);
      const nullCount = eligibleRows.length - populatedRows.length;
      return [
        field,
        {
          eligibleCount: eligibleRows.length,
          populatedCount: populatedRows.length,
          nullCount,
          coverageRatio: ratio(populatedRows.length, eligibleRows.length),
          nullRate: ratio(nullCount, eligibleRows.length),
          ineligibleCount: sourceRows.length - eligibleRows.length,
          bestEligibleCount: bestEligible.length,
          bestPopulatedCount: bestPopulated.length,
          bestCoverageRatio: ratio(bestPopulated.length, bestEligible.length),
          altEligibleCount: eligibleRows.length - bestEligible.length,
          altPopulatedCount: populatedRows.length - bestPopulated.length,
          altCoverageRatio: ratio(
            populatedRows.length - bestPopulated.length,
            eligibleRows.length - bestEligible.length,
          ),
        },
      ];
    }),
  ) as YieldSourceRiskCoverageSummary["fields"];

  const coreRatios = SOURCE_RISK_CORE_COVERAGE_FIELDS
    .map((field) => fields[field].coverageRatio)
    .filter((coverageRatio): coverageRatio is number => coverageRatio != null);
  const status: YieldHealthFieldStatus = coreRatios.length === 0
    ? "unknown"
    : Math.min(...coreRatios) >= STATUS_YIELD_HEALTH_THRESHOLDS.sourceRiskCoverageRatio
      ? "healthy"
      : "degraded";

  return {
    status,
    threshold: STATUS_YIELD_HEALTH_THRESHOLDS.sourceRiskCoverageRatio,
    totalRows: sourceRows.length,
    bestRows: sourceRows.filter((row) => row.isBest).length,
    altRows: sourceRows.filter((row) => !row.isBest).length,
    // A bare `{}` is not source-risk evidence (A11): a row counts only when it
    // carries at least one populated coverage field.
    rowsWithSourceRisk: sourceRows.filter((row) =>
      row.sourceRisk != null
      && SOURCE_RISK_COVERAGE_FIELDS.some((field) => sourceRiskValuePopulated(field, row.sourceRisk?.[field])),
    ).length,
    fields,
  };
}

function getPublishedBenchmarkKey(row: Record<string, unknown>): YieldBenchmarkKey | string {
  const provenance = getObject(row.provenance);
  return getString(row.benchmarkKey) ?? getString(provenance?.benchmarkKey) ?? "USD";
}

function benchmarkAgeSeconds(
  now: number,
  meta: Record<string, unknown> | null,
): { fetchedAt: number | null; ageSec: number | null } {
  const fetchedAt = getNumber(meta?.fetchedAt);
  return {
    fetchedAt,
    ageSec: fetchedAt != null ? ageSeconds(now, fetchedAt) : getNumber(meta?.ageSeconds),
  };
}

function buildBenchmarkRegistryHealth(params: {
  now: number;
  rankings: unknown[] | null;
  rankingsPayload: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
}): YieldHealthSummary["benchmarkRegistry"] {
  const usage = new Map<YieldBenchmarkKey, {
    rowCount: number;
    fallbackSelectionRowCount: number;
    proxySelectionRowCount: number;
  }>();
  const unknownKeyRowCounts: Record<string, number> = {};
  for (const ranking of params.rankings ?? []) {
    const row = getObject(ranking);
    if (!row) continue;
    const provenance = getObject(row.provenance);
    const publishedKey = getPublishedBenchmarkKey(row);
    if (!YIELD_BENCHMARK_KEY_VALUES.includes(publishedKey as YieldBenchmarkKey)) {
      // A6: an unrecognised key used to be coerced to USD, hiding it entirely.
      unknownKeyRowCounts[publishedKey] = (unknownKeyRowCounts[publishedKey] ?? 0) + 1;
      continue;
    }
    const key = publishedKey as YieldBenchmarkKey;
    const current = usage.get(key) ?? { rowCount: 0, fallbackSelectionRowCount: 0, proxySelectionRowCount: 0 };
    current.rowCount += 1;
    const selectionMode =
      getString(row.benchmarkSelectionMode) ?? getString(provenance?.benchmarkSelectionMode);
    if (selectionMode === "fallback-usd") current.fallbackSelectionRowCount += 1;
    if (selectionMode === "fallback-usd" || getBoolean(row.benchmarkIsProxy) === true) {
      current.proxySelectionRowCount += 1;
    }
    usage.set(key, current);
  }

  const registry =
    getObject(params.rankingsPayload?.benchmarks) ??
    getObject(params.provenance?.benchmarks);
  const legacyUsdMeta = getObject(params.provenance?.benchmark);
  const benchmarks = Object.fromEntries(
    [...usage.entries()].map(([key, counts]) => {
      const meta = getObject(registry?.[key]) ?? (key === "USD" ? legacyUsdMeta : null);
      const { fetchedAt, ageSec } = benchmarkAgeSeconds(params.now, meta);
      const isFallback = getBoolean(meta?.isFallback);
      const fallbackMode = getString(meta?.fallbackMode);
      const recordDate = getString(meta?.recordDate);
      const maxRecordAgeSec = YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key];
      const recordAgeSec = recordAgeSeconds(params.now, recordDate);
      // A1: the entry's health is a property of the feed only. Rows selecting
      // this key as a documented proxy are counted, never classified.
      // A2: the observation bound is evaluated here against the status clock;
      // `classifyYieldBenchmarkFreshness` resolves `recordDate` against the wall
      // clock, which the status layer cannot inject.
      const status: YieldHealthFieldStatus = meta == null
        ? "unknown"
        : recordAgeSec != null && recordAgeSec > maxRecordAgeSec
          ? "stale"
          : classifyYieldBenchmarkFreshness({
              ageSeconds: ageSec,
              isFallback: isFallback === true,
              fallbackMode,
            });
      return [
        key,
        {
          key,
          label: getString(meta?.label),
          currency: getString(meta?.currency),
          rowCount: counts.rowCount,
          fallbackSelectionRowCount: counts.fallbackSelectionRowCount,
          proxySelectionRowCount: counts.proxySelectionRowCount,
          fetchedAt,
          ageSec,
          maxAgeSec: YIELD_BENCHMARK_SCORE_TTL_SEC,
          recordDate,
          recordAgeSec: recordAgeSeconds(params.now, recordDate),
          maxRecordAgeSec,
          source: getString(meta?.source),
          isFallback,
          fallbackMode,
          status,
        },
      ];
    }),
  ) as YieldHealthSummary["benchmarkRegistry"]["benchmarks"];
  const entries = Object.values(benchmarks);
  // A6: keys the producer fetched that no published row uses are monitored but
  // never status-bearing — a stale unused key (CAD) is not an incident.
  const unusedBenchmarkKeys = Object.entries(registry ?? {})
    .filter(([key]) => !usage.has(key as YieldBenchmarkKey))
    .map(([key, value]) => {
      const meta = getObject(value);
      const recordDate = getString(meta?.recordDate);
      return {
        key,
        source: getString(meta?.source),
        recordDate,
        recordAgeSec: recordAgeSeconds(params.now, recordDate),
        ageSec: benchmarkAgeSeconds(params.now, meta).ageSec,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const unknownKeys = Object.keys(unknownKeyRowCounts).sort();
  const nonHealthyCount = entries.filter((entry) => entry.status !== "healthy").length;

  return {
    status: entries.length === 0
      ? "unknown"
      : nonHealthyCount > 0 || unknownKeys.length > 0
        ? "degraded"
        : "healthy",
    usedBenchmarkCount: entries.length,
    healthyBenchmarkCount: entries.filter((entry) => entry.status === "healthy").length,
    degradedBenchmarkCount: entries.filter((entry) => entry.status === "degraded").length,
    staleBenchmarkCount: entries.filter((entry) => entry.status === "stale").length,
    unknownBenchmarkCount: entries.filter((entry) => entry.status === "unknown").length,
    benchmarks,
    unusedBenchmarkKeys,
    unknownKeys,
    unknownKeyRowCount: Object.values(unknownKeyRowCounts).reduce((total, count) => total + count, 0),
  };
}

function getArrayCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function getCount(payload: Record<string, unknown> | null, countKey: string, arrayKey?: string): number | null {
  return getNumber(payload?.[countKey]) ?? (arrayKey ? getArrayCount(payload?.[arrayKey]) : null);
}

function sumKnown(values: Array<number | null>): number | null {
  let hasKnownValue = false;
  let total = 0;
  for (const value of values) {
    if (value == null) continue;
    hasKnownValue = true;
    total += value;
  }
  return hasKnownValue ? total : null;
}

const COVERAGE_AUDIT_COUNT_FIELDS = [
  ["manifestMissingCount", "manifestMissingIds"],
  ["yieldBearingMissingFromRankingsCount", "yieldBearingMissingFromRankings"],
  ["unmatchedHighTvlPoolCount", "unmatchedHighTvlPools"],
  ["missingProtocolCount", "missingProtocols"],
  ["nativeExactPoolRecommendationCount", "nativeExactPoolRecommendations"],
  ["sourceFamilyAdapterRecommendationCount", "sourceFamilyAdapterRecommendations"],
  ["lendingAllowlistRecommendationCount", "lendingAllowlistRecommendations"],
  ["venueRiskConfigMissingCount", "venueRiskConfigMissing"],
  ["staleAutoLendingOverrideCount", "staleAutoLendingOverrides"],
  ["staleVenueRiskScoreCount", "staleVenueRiskScores"],
] as const;

type CoverageAuditCountKey = typeof COVERAGE_AUDIT_COUNT_FIELDS[number][0];
type CoverageAuditCounts = Record<CoverageAuditCountKey, number | null>;

function buildCoverageAuditCounts(payload: Record<string, unknown> | null): CoverageAuditCounts {
  return Object.fromEntries(
    COVERAGE_AUDIT_COUNT_FIELDS.map(([countKey, arrayKey]) => [
      countKey,
      getCount(payload, countKey, arrayKey),
    ]),
  ) as CoverageAuditCounts;
}

function sanitizeQueueItem(value: unknown): YieldCoverageAuditQueueItem | null {
  const row = getObject(value);
  const kind = getQueueKind(row?.kind);
  const id = getString(row?.id);
  const title = getString(row?.title);
  const detail = getString(row?.detail);
  if (!row || !kind || !id || !title || !detail) return null;

  const item: YieldCoverageAuditQueueItem = {
    id,
    kind,
    title,
    detail,
    actionHint: getQueueAction(row.actionHint),
  };
  const stablecoinIds = getStringArray(row.stablecoinIds);
  if (stablecoinIds && stablecoinIds.length > 0) item.stablecoinIds = stablecoinIds;
  const project = getString(row.project);
  if (project) item.project = project;
  const pool = getString(row.pool);
  if (pool) item.pool = pool;
  const symbol = getString(row.symbol);
  if (symbol) item.symbol = symbol;
  const chain = getString(row.chain);
  if (chain) item.chain = chain;
  const tvlUsd = getNumber(row.tvlUsd);
  if (tvlUsd != null) item.tvlUsd = tvlUsd;
  const apy = getNumber(row.apy);
  if (apy != null) item.apy = apy;
  const poolCount = getNumber(row.poolCount);
  if (poolCount != null) item.poolCount = poolCount;
  const totalTvlUsd = getNumber(row.totalTvlUsd);
  if (totalTvlUsd != null) item.totalTvlUsd = totalTvlUsd;
  const recommendedTier = getString(row.recommendedTier);
  if (recommendedTier === "high-confidence" || recommendedTier === "review-needed") {
    item.recommendedTier = recommendedTier;
  }
  return item;
}

function readQueueItems(value: unknown): YieldCoverageAuditQueueItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(sanitizeQueueItem);
  if (items.some((item) => item == null)) return null;
  return items as YieldCoverageAuditQueueItem[];
}

function readAllowedQueueActions(operatorQueue: Record<string, unknown> | null): YieldCoverageAuditQueueAction[] {
  const published = Array.isArray(operatorQueue?.allowedActions)
    ? operatorQueue.allowedActions.filter((action): action is YieldCoverageAuditQueueAction =>
        COVERAGE_AUDIT_QUEUE_ACTIONS.includes(action as YieldCoverageAuditQueueAction))
    : [];
  return published.length > 0 ? published : COVERAGE_AUDIT_QUEUE_ACTIONS;
}

function readQueueTotals(payload: Record<string, unknown> | null): YieldHealthSummary["coverageAudit"]["queueTotals"] {
  const totals = getObject(payload?.queueTotals);
  if (!totals) return null;
  const byKind = getObject(totals.byKind);
  return {
    byKind: Object.fromEntries(
      Object.entries(byKind ?? {}).flatMap(([kind, value]) => {
        const count = getNumber(value);
        return count != null ? [[kind, count] as const] : [];
      }),
    ),
    suppressedItemCount: getNumber(totals.suppressedItemCount) ?? 0,
    truncated: getBoolean(totals.truncated) ?? false,
  };
}

function buildCoverageAuditQueue(payload: Record<string, unknown> | null): Pick<
  YieldHealthSummary["coverageAudit"],
  "headlineGaps" | "recommendationCandidates" | "allowedActions" | "queuePersistence" | "queueTotals" | "queueDisplayOnly"
> {
  const operatorQueue = getObject(payload?.operatorQueue);
  const queuedHeadlineGaps = readQueueItems(operatorQueue?.headlineGaps);
  const queuedRecommendations = readQueueItems(operatorQueue?.recommendationCandidates);
  const queuePersistence = operatorQueue?.persistence;
  const queueTotals = readQueueTotals(payload);
  // The panel lists dispositions; nothing writes them back until the admin
  // disposition route lands, so the surface is explicitly display-only (C8).
  const shared = {
    allowedActions: readAllowedQueueActions(operatorQueue),
    queueTotals,
    queueDisplayOnly: true,
  };
  // The current queue is authoritative when its required arrays are present,
  // including when both arrays are empty after disposition filtering.
  if (
    queuedHeadlineGaps &&
    queuedRecommendations &&
    (queuePersistence === "deferred" || queuePersistence === "durable")
  ) {
    return {
      ...shared,
      headlineGaps: queuedHeadlineGaps.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
      recommendationCandidates: queuedRecommendations.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
      queuePersistence,
    };
  }

  return {
    ...shared,
    headlineGaps: [],
    recommendationCandidates: [],
    queuePersistence: "deferred",
  };
}

function buildSupplementalHealth(
  now: number,
  byKey: Map<string, CacheRow>,
): YieldHealthSummary["supplemental"] {
  const familyRows = SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => {
    const row = byKey.get(getYieldSupplementalFamilyCacheKey(family)) ?? null;
    const ageSec = ageSeconds(now, row?.updated_at);
    const payload = safeJsonObjectParse(
      row?.value ?? null,
      `yield-health:supplemental:${family}`,
    );
    const sourceCount = getNumber(payload?.sourceCount);
    const status = freshnessStatus(
      ageSec,
      STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
      { missingIs: "unknown", degradedAfterOne: true },
    );
    return {
      family,
      updatedAt: row?.updated_at ?? null,
      ageSec,
      sourceCount,
      status,
    };
  });
  const requiredFamilySet = new Set(REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS);
  const requiredFamilyRows = familyRows.filter((row) => requiredFamilySet.has(row.family));
  const families = Object.fromEntries(
    familyRows.map((row) => [
      row.family,
      {
        updatedAt: row.updatedAt,
        ageSec: row.ageSec,
        sourceCount: row.sourceCount,
        status: row.status,
      },
    ]),
  );

  if (!requiredFamilyRows.some((row) => row.updatedAt != null)) {
    return {
      updatedAt: null,
      ageSec: null,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
      status: "unknown",
      familyCount: 0,
      freshFamilyCount: 0,
      degradedFamilyCount: 0,
      staleFamilyCount: 0,
      missingFamilyCount: REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
      families,
    };
  }

  const familyStatuses = requiredFamilyRows.map((row) => row.status);
  const latestFamilyUpdatedAt = Math.max(
    ...requiredFamilyRows.map((row) => row.updatedAt ?? 0),
  ) || null;
  return {
    updatedAt: latestFamilyUpdatedAt,
    ageSec: ageSeconds(now, latestFamilyUpdatedAt),
    maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
    status: worstStatus(familyStatuses),
    familyCount: requiredFamilyRows.length,
    freshFamilyCount: requiredFamilyRows.filter((row) => row.status === "healthy").length,
    degradedFamilyCount: requiredFamilyRows.filter((row) => row.status === "degraded").length,
    staleFamilyCount: requiredFamilyRows.filter((row) => row.status === "stale").length,
    missingFamilyCount: requiredFamilyRows.filter((row) => row.status === "unknown").length,
    families,
  };
}

/**
 * C5: the tile used to read only the publish-time safety snapshot, so a read
 * path serving the publish-time fallback (or, past the stale-coherent window,
 * unrated safety) was invisible here. Reproduces `/api/health`'s identity
 * comparison from D1-side extracts only.
 */
async function buildLiveSafetyHydration(
  db: D1Database,
  now: number,
  safetySnapshot: Record<string, unknown> | null,
  rankingUpdatedAt: number | null,
): Promise<NonNullable<YieldHealthSummary["liveSafetyHydration"]>> {
  const cachedAgeSec = ageSeconds(now, rankingUpdatedAt);
  const base = {
    staleCoherentMaxAgeSec: YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC,
    cachedAgeSec,
  };
  if (safetySnapshot == null) {
    return { ...base, status: "unknown", reason: null, fallback: null };
  }
  let live = null;
  try {
    live = await loadSafetyScoreV9PublicationIdentityEnvelope(db);
  } catch {
    // Without the active identity there is nothing to compare against, so the
    // hydration state is unmeasured rather than degraded.
    return { ...base, status: "unknown", reason: "identity-lookup-failed", fallback: null };
  }
  const stamped = SafetyScorePublicationIdentitySchema.safeParse(safetySnapshot.safetyScoreIdentity);
  if (!stamped.success) {
    return { ...base, status: "degraded", reason: "safety-identity-missing", fallback: null };
  }
  if (live && safetyScorePublicationIdentitiesAreComparable(stamped.data, live)) {
    return { ...base, status: "healthy", reason: null, fallback: null };
  }
  const reason = live ? "safety-identity-mismatch" : "safety-snapshot-unavailable";
  // Past the stale-coherent window the public surface blanks safety to NR.
  const pastWindow = cachedAgeSec != null && cachedAgeSec > YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC;
  return {
    ...base,
    status: pastWindow ? "stale" : "degraded",
    reason,
    fallback: pastWindow ? null : "publish-time-snapshot",
  };
}

/**
 * C3: `pys_inputs_at_publish` is written as null whenever the safety snapshot is
 * unavailable, which silently loses the reproducibility evidence for those rows.
 */
function buildPysInputsPersistence(
  crons: Record<string, CronStatus>,
): NonNullable<YieldHealthSummary["pysInputs"]> {
  const metadata = getSyncYieldDataMetadata(crons);
  const publication = getObject(metadata?.publication);
  const persistedCount =
    getNumber(metadata?.pysInputsPersistedCount) ?? getNumber(publication?.pysInputsPersistedCount);
  const nullCount =
    getNumber(metadata?.pysInputsNullCount) ?? getNumber(publication?.pysInputsNullCount);
  const total = (persistedCount ?? 0) + (nullCount ?? 0);
  const nullRate = persistedCount == null && nullCount == null
    ? null
    : ratio(nullCount ?? 0, total);
  return {
    status: nullRate == null
      ? "unknown"
      : nullRate > PYS_INPUTS_NULL_RATE_BUDGET
        ? "degraded"
        : "healthy",
    persistedCount,
    nullCount,
    nullRate,
    threshold: PYS_INPUTS_NULL_RATE_BUDGET,
  };
}

export async function loadYieldHealthSummary(
  db: D1Database,
  now: number,
  crons: Record<string, CronStatus>,
): Promise<YieldHealthSummary> {
  const rows = await db
    .prepare(
      `SELECT key, value, updated_at
       FROM cache
       WHERE key IN ('yield-rankings', 'yield-coverage-audit')
          OR key LIKE 'yield:supplemental-sources:v1:%'`,
    )
    .all<CacheRow>();
  const byKey = new Map((rows.results ?? []).map((row) => [row.key, row]));

  const rankingsRow = byKey.get(YIELD_RANKINGS_CACHE_KEY) ?? null;
  const rankingsPayload = safeJsonObjectParse(
    rankingsRow?.value ?? null,
    `yield-health:cache:${YIELD_RANKINGS_CACHE_KEY}`,
  );
  const rankingUpdatedAt = rankingsRow?.updated_at ?? getNumber(rankingsPayload?.updatedAt);
  const rankingAgeSec = ageSeconds(now, rankingUpdatedAt);
  const rankingStatus = rankingsPayload == null
    ? "stale"
    : freshnessStatus(rankingAgeSec, YIELD_RANKING_MAX_AGE_SEC, {
        missingIs: "stale",
        thresholds: YIELD_RANKING_RATIO_THRESHOLDS,
      });
  const rankings = Array.isArray(rankingsPayload?.rankings) ? rankingsPayload.rankings : null;
  const sourceRiskCoverage = buildSourceRiskCoverage(rankings);
  const { previousRankingCount, rankingCountDelta } = getSyncYieldRankingDeltaMetadata(crons);

  const provenance = getObject(rankingsPayload?.provenance);
  const safetySnapshot = getObject(provenance?.safetySnapshot);
  const safetyCoverageRatio = getNumber(safetySnapshot?.coverageRatio);
  const safetyCoverageStatus: YieldHealthFieldStatus = safetyCoverageRatio == null
    ? "unknown"
    : safetyCoverageRatio < STATUS_YIELD_HEALTH_THRESHOLDS.safetyCoverageRatio
      ? "degraded"
      : "healthy";

  const supplemental = buildSupplementalHealth(now, byKey);

  const benchmark = getObject(provenance?.benchmark);
  const benchmarkFetchedAt = getNumber(benchmark?.fetchedAt);
  const benchmarkAgeSec = ageSeconds(now, benchmarkFetchedAt) ?? getNumber(benchmark?.ageSeconds);
  const benchmarkIsFallback = getBoolean(benchmark?.isFallback);
  const benchmarkStatus: YieldHealthFieldStatus = benchmark == null
    ? "unknown"
    : classifyYieldBenchmarkFreshness({
        ageSeconds: benchmarkAgeSec,
        isFallback: benchmarkIsFallback === true,
        fallbackMode: getString(benchmark.fallbackMode),
      });
  const benchmarkRegistry = buildBenchmarkRegistryHealth({
    now,
    rankings,
    rankingsPayload,
    provenance,
  });

  const coverageAuditUpdatedAt = byKey.get(YIELD_COVERAGE_AUDIT_CACHE_KEY)?.updated_at ?? null;
  const coverageAuditPayload = safeJsonObjectParse(
    byKey.get(YIELD_COVERAGE_AUDIT_CACHE_KEY)?.value ?? null,
    `yield-health:cache:${YIELD_COVERAGE_AUDIT_CACHE_KEY}`,
  );
  const coverageAuditAgeSec = ageSeconds(now, coverageAuditUpdatedAt);
  const coverageAuditFreshness = freshnessStatus(
    coverageAuditAgeSec,
    STATUS_YIELD_HEALTH_THRESHOLDS.coverageAuditMaxAgeSec,
    { missingIs: "unknown", degradedAfterOne: true },
  );
  const coverageAuditCounts = buildCoverageAuditCounts(coverageAuditPayload);
  const headlineGapCount = sumKnown([
    coverageAuditCounts.manifestMissingCount,
    coverageAuditCounts.yieldBearingMissingFromRankingsCount,
    coverageAuditCounts.staleAutoLendingOverrideCount,
    coverageAuditCounts.unmatchedHighTvlPoolCount,
    coverageAuditCounts.missingProtocolCount,
  ]);
  const recommendationCandidateCount = sumKnown([
    coverageAuditCounts.nativeExactPoolRecommendationCount,
    coverageAuditCounts.sourceFamilyAdapterRecommendationCount,
    coverageAuditCounts.lendingAllowlistRecommendationCount,
    coverageAuditCounts.venueRiskConfigMissingCount,
    coverageAuditCounts.staleVenueRiskScoreCount,
  ]);
  // C4: a queue nobody can drain within a cycle is a status signal, not a list.
  const queueOverBudget =
    (headlineGapCount ?? 0) > COVERAGE_AUDIT_QUEUE_BUDGET.headlineGaps ||
    (recommendationCandidateCount ?? 0) > COVERAGE_AUDIT_QUEUE_BUDGET.recommendationCandidates;
  const coverageAuditStatus: YieldHealthFieldStatus =
    queueOverBudget && coverageAuditFreshness === "healthy" ? "degraded" : coverageAuditFreshness;
  const coverageAuditQueue = buildCoverageAuditQueue(coverageAuditPayload);
  const comparisonAnchorFreshness = buildComparisonAnchorFreshnessSummary(crons);
  const liveSafetyHydration = await buildLiveSafetyHydration(db, now, safetySnapshot, rankingUpdatedAt);
  const pysInputs = buildPysInputsPersistence(crons);

  const status = worstStatus([
    rankingStatus,
    safetyCoverageStatus,
    supplemental.status,
    benchmarkRegistry.status,
    coverageAuditStatus,
    sourceRiskCoverage.status,
    // Unmeasurable is not degraded for these two: both depend on evidence the
    // producer may not have emitted for this run.
    ...(liveSafetyHydration.status === "unknown" ? [] : [liveSafetyHydration.status]),
    ...(pysInputs.status === "unknown" ? [] : [pysInputs.status]),
  ]);

  return {
    status,
    statusImpact: rankingStatus === "stale" ? "public-critical" : "admin-watch",
    runbookUrl: YIELD_RUNBOOK_URL,
    rankingCount: rankings?.length ?? null,
    rankingCountDelta,
    previousRankingCount,
    rankingUpdatedAt,
    rankingAgeSec,
    rankingMaxAgeSec: YIELD_RANKING_MAX_AGE_SEC,
    rankingStatus,
    safetyCoverage: {
      coveredCount: getNumber(safetySnapshot?.coveredCount),
      trackedCount: getNumber(safetySnapshot?.trackedCount),
      coverageRatio: safetyCoverageRatio,
      threshold: STATUS_YIELD_HEALTH_THRESHOLDS.safetyCoverageRatio,
      status: safetyCoverageStatus,
      reason: getString(safetySnapshot?.reason),
    },
    supplemental,
    benchmark: {
      fetchedAt: benchmarkFetchedAt,
      ageSec: benchmarkAgeSec,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.benchmarkMaxAgeSec,
      source: getString(benchmark?.source),
      isFallback: benchmarkIsFallback,
      fallbackMode: getString(benchmark?.fallbackMode),
      status: benchmarkStatus,
    },
    benchmarkRegistry,
    coverageAudit: {
      updatedAt: coverageAuditUpdatedAt,
      ageSec: coverageAuditAgeSec,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.coverageAuditMaxAgeSec,
      status: coverageAuditStatus,
      headlineGapCount,
      recommendationCandidateCount,
      queueBudget: COVERAGE_AUDIT_QUEUE_BUDGET,
      ...coverageAuditCounts,
      ...coverageAuditQueue,
    },
    sourceRiskCoverage,
    comparisonAnchorFreshness,
    latestCronStatus: crons["sync-yield-data"]?.lastRun?.status ?? null,
    latestCronStartedAt: crons["sync-yield-data"]?.lastRun?.startedAt ?? null,
    liveSafetyHydration,
    pysInputs,
  };
}
