import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { STATUS_CACHE_RATIO_THRESHOLDS, STATUS_YIELD_HEALTH_THRESHOLDS } from "@shared/lib/status-thresholds";
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
import { YIELD_SUPPLEMENTAL_CACHE_KEY, getYieldSupplementalFamilyCacheKey } from "../../cron/yield-sync/cache";
import {
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "../../cron/yield-sync/supplemental-source-families";
import { getBoolean, getNumber, getObject, getString } from "../../cron/dews/source-state/legacy-bridge";
import { safeJsonParse } from "../api-cache-read";
import {
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_SCORE_TTL_SEC,
} from "../../cron/yield-sync/benchmarks";

const YIELD_RUNBOOK_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/yield-health.md";
const YIELD_RANKINGS_CACHE_KEY = "yield-rankings";
const YIELD_COVERAGE_AUDIT_CACHE_KEY = "yield-coverage-audit";
const YIELD_RANKING_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];
const COVERAGE_AUDIT_QUEUE_ITEM_LIMIT = 6;
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

function freshnessStatus(
  ageSec: number | null,
  maxAgeSec: number,
  options?: { missingIs?: YieldHealthFieldStatus; degradedAfterOne?: boolean },
): YieldHealthFieldStatus {
  if (ageSec == null) return options?.missingIs ?? "unknown";
  const ratio = ageSec / maxAgeSec;
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale) return "stale";
  if (options?.degradedAfterOne && ageSec > maxAgeSec) return "degraded";
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) return "degraded";
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

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
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

function hasSourceRiskPenaltyEvidence(sourceRisk: Record<string, unknown> | null): boolean {
  if (!sourceRisk) return false;
  return [
    sourceRisk.rewardShare,
    sourceRisk.sourceDepthRatio,
    sourceRisk.sourceAgeSeconds,
    sourceRisk.observationCount30d,
    sourceRisk.sourceSwitchCount30d,
  ].some((value) => typeof value === "number" && Number.isFinite(value))
    || sourceRisk.venueRiskTier === "low"
    || sourceRisk.venueRiskTier === "medium"
    || sourceRisk.venueRiskTier === "high";
}

function buildSourceRiskCoverage(rankings: unknown[] | null): YieldSourceRiskCoverageSummary {
  const sourceRows: Array<{ sourceRisk: Record<string, unknown> | null; isBest: boolean }> = [];

  for (const ranking of rankings ?? []) {
    const row = getObject(ranking);
    if (!row) continue;
    sourceRows.push({
      sourceRisk: getObject(row.sourceRisk),
      isBest: true,
    });

    if (Array.isArray(row.altSources)) {
      for (const alt of row.altSources) {
        const altRow = getObject(alt);
        if (!altRow) continue;
        sourceRows.push({
          sourceRisk: getObject(altRow.sourceRisk),
          isBest: false,
        });
      }
    }
  }

  const fields = Object.fromEntries(
    SOURCE_RISK_COVERAGE_FIELDS.map((field) => {
      const eligibleRows =
        field === "sourceSwitchCount30d"
          ? sourceRows.filter((row) => row.isBest)
          : sourceRows;
      const populatedCount = eligibleRows.filter((row) =>
        field === "sourceRiskPenalty"
          ? sourceRiskValuePopulated(field, row.sourceRisk?.[field]) && hasSourceRiskPenaltyEvidence(row.sourceRisk)
          : sourceRiskValuePopulated(field, row.sourceRisk?.[field]),
      ).length;
      const nullCount = Math.max(0, eligibleRows.length - populatedCount);
      return [
        field,
        {
          eligibleCount: eligibleRows.length,
          populatedCount,
          nullCount,
          coverageRatio: ratio(populatedCount, eligibleRows.length),
          nullRate: eligibleRows.length > 0 ? ratio(nullCount, eligibleRows.length) : 0,
        },
      ];
    }),
  ) as YieldSourceRiskCoverageSummary["fields"];

  const coreRatios = SOURCE_RISK_CORE_COVERAGE_FIELDS
    .map((field) => fields[field])
    .filter((field) => field.eligibleCount > 0)
    .map((field) => field.coverageRatio);
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
    rowsWithSourceRisk: sourceRows.filter((row) => row.sourceRisk != null).length,
    fields,
  };
}

function getPublishedBenchmarkKey(row: Record<string, unknown>): YieldBenchmarkKey {
  const provenance = getObject(row.provenance);
  const key = getString(row.benchmarkKey) ?? getString(provenance?.benchmarkKey);
  return YIELD_BENCHMARK_KEY_VALUES.includes(key as YieldBenchmarkKey)
    ? key as YieldBenchmarkKey
    : "USD";
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
  const usage = new Map<YieldBenchmarkKey, { rowCount: number; fallbackSelectionRowCount: number }>();
  for (const ranking of params.rankings ?? []) {
    const row = getObject(ranking);
    if (!row) continue;
    const provenance = getObject(row.provenance);
    const key = getPublishedBenchmarkKey(row);
    const current = usage.get(key) ?? { rowCount: 0, fallbackSelectionRowCount: 0 };
    current.rowCount += 1;
    if (
      getString(row.benchmarkSelectionMode) === "fallback-usd" ||
      getString(provenance?.benchmarkSelectionMode) === "fallback-usd"
    ) {
      current.fallbackSelectionRowCount += 1;
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
      const status: YieldHealthFieldStatus = meta == null
        ? "unknown"
        : classifyYieldBenchmarkFreshness(
            {
              ageSeconds: ageSec,
              isFallback: isFallback === true,
              fallbackMode,
            },
            {
              selectionMode: counts.fallbackSelectionRowCount > 0 ? "fallback-usd" : null,
            },
          );
      return [
        key,
        {
          key,
          label: getString(meta?.label),
          currency: getString(meta?.currency),
          rowCount: counts.rowCount,
          fallbackSelectionRowCount: counts.fallbackSelectionRowCount,
          fetchedAt,
          ageSec,
          maxAgeSec: YIELD_BENCHMARK_SCORE_TTL_SEC,
          source: getString(meta?.source),
          isFallback,
          fallbackMode,
          status,
        },
      ];
    }),
  ) as YieldHealthSummary["benchmarkRegistry"]["benchmarks"];
  const entries = Object.values(benchmarks);
  const nonHealthyCount = entries.filter((entry) => entry.status !== "healthy").length;

  return {
    status: entries.length === 0 ? "unknown" : nonHealthyCount > 0 ? "degraded" : "healthy",
    usedBenchmarkCount: entries.length,
    healthyBenchmarkCount: entries.filter((entry) => entry.status === "healthy").length,
    degradedBenchmarkCount: entries.filter((entry) => entry.status === "degraded").length,
    staleBenchmarkCount: entries.filter((entry) => entry.status === "stale").length,
    unknownBenchmarkCount: entries.filter((entry) => entry.status === "unknown").length,
    benchmarks,
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

function readQueueItems(value: unknown): YieldCoverageAuditQueueItem[] {
  return Array.isArray(value)
    ? value.map(sanitizeQueueItem).filter((item): item is YieldCoverageAuditQueueItem => item != null)
    : [];
}

function legacyPoolQueueItem(
  kind: Extract<YieldCoverageAuditQueueItemKind, "unmatched-high-tvl-pool" | "missing-protocol" | "native-exact-pool">,
  row: Record<string, unknown>,
): YieldCoverageAuditQueueItem | null {
  const pool = getString(row.pool);
  const project = getString(row.project);
  const symbol = getString(row.symbol);
  const chain = getString(row.chain);
  if (!pool || !project || !symbol || !chain) return null;
  const stablecoinIds = getStringArray(row.stablecoinIds);
  return {
    id: `${kind}:${pool}`,
    kind,
    title: `${symbol} on ${project}`,
    detail: kind === "native-exact-pool" && stablecoinIds?.length
      ? `${chain} native pool for ${stablecoinIds.join(", ")}`
      : `${chain} pool ${pool}`,
    actionHint: kind === "native-exact-pool" ? "accept" : "watch",
    stablecoinIds: stablecoinIds ?? undefined,
    project,
    pool,
    symbol,
    chain,
    tvlUsd: getNumber(row.tvlUsd) ?? undefined,
    apy: getNumber(row.apy) ?? undefined,
  };
}

function legacyStaleAutoLendingOverrideQueueItem(row: Record<string, unknown>): YieldCoverageAuditQueueItem | null {
  const stablecoinId = getString(row.stablecoinId);
  const pool = getString(row.pool);
  if (!stablecoinId || !pool) return null;
  const reasons = getStringArray(row.reasons) ?? [];
  return {
    id: `stale-auto-lending-override:${stablecoinId}:${pool}`,
    kind: "stale-auto-lending-override",
    title: stablecoinId,
    detail: `Override ${pool} no longer qualifies${reasons.length ? `: ${reasons.join(", ")}` : ""}`,
    actionHint: "accept",
    stablecoinIds: [stablecoinId],
    pool,
    project: getString(row.project) ?? undefined,
    symbol: getString(row.symbol) ?? undefined,
    chain: getString(row.chain) ?? undefined,
    tvlUsd: getNumber(row.tvlUsd) ?? undefined,
    apy: getNumber(row.apy) ?? undefined,
  };
}

function legacyProtocolQueueItem(
  kind: Extract<YieldCoverageAuditQueueItemKind, "source-family-adapter" | "lending-allowlist">,
  row: Record<string, unknown>,
): YieldCoverageAuditQueueItem | null {
  const project = getString(row.project);
  const poolCount = getNumber(row.poolCount);
  const totalTvlUsd = getNumber(row.totalTvlUsd);
  if (!project || poolCount == null || totalTvlUsd == null) return null;
  const recommendedTier = getString(row.recommendedTier);
  const examplePools = getStringArray(row.examplePools) ?? [];
  return {
    id: `${kind}:${project}`,
    kind,
    title: project,
    detail: `${poolCount} pools${examplePools.length ? ` across ${examplePools.slice(0, 3).join(", ")}` : ""}`,
    actionHint: recommendedTier === "high-confidence" ? "accept" : "watch",
    project,
    poolCount,
    totalTvlUsd,
    recommendedTier: recommendedTier === "high-confidence" || recommendedTier === "review-needed"
      ? recommendedTier
      : undefined,
  };
}

function legacyStaleVenueRiskScoreQueueItem(row: Record<string, unknown>): YieldCoverageAuditQueueItem | null {
  const protocol = getString(row.protocol) ?? getString(row.project) ?? getString(row.title);
  if (!protocol) return null;
  const reviewedAt = getString(row.reviewedAt);
  const ageDays = getNumber(row.ageDays);
  const confidence = getString(row.confidence);
  const ageText = ageDays != null ? ` (${Math.round(ageDays)}d ago)` : "";
  const confidenceText = confidence && confidence !== "verified" ? `, ${confidence} confidence` : "";
  return {
    id: `stale-venue-risk-score:${protocol}`,
    kind: "stale-venue-risk-score",
    title: protocol,
    detail: reviewedAt
      ? `Venue-risk score last reviewed ${reviewedAt}${ageText}${confidenceText}; re-verify audits, governance, and TVL.`
      : "Venue-risk score needs re-verification.",
    actionHint: "watch",
    project: protocol,
  };
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(getObject).filter((row): row is Record<string, unknown> => row != null)
    : [];
}

function buildCoverageAuditQueue(payload: Record<string, unknown> | null): Pick<
  YieldHealthSummary["coverageAudit"],
  "headlineGaps" | "recommendationCandidates" | "allowedActions" | "queuePersistence"
> {
  const operatorQueue = getObject(payload?.operatorQueue);
  const queuedHeadlineGaps = readQueueItems(operatorQueue?.headlineGaps);
  const queuedRecommendations = readQueueItems(operatorQueue?.recommendationCandidates);
  if (queuedHeadlineGaps.length > 0 || queuedRecommendations.length > 0) {
    return {
      headlineGaps: queuedHeadlineGaps.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
      recommendationCandidates: queuedRecommendations.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
      allowedActions: COVERAGE_AUDIT_QUEUE_ACTIONS,
      queuePersistence: "deferred",
    };
  }

  // LEGACY FALLBACK PATH — reached only when the payload lacks a populated
  // `operatorQueue`. The seven legacyXxx builders below reconstruct queue items
  // from the pre-operatorQueue per-list wire format. Remove this entire block
  // (and the legacyXxx helpers) once the yield-coverage-audit payload adopts
  // `operatorQueue` universally; new queue item kinds should be added to the
  // operatorQueue path above, not duplicated here.
  const manifestMissingIds = getStringArray(payload?.manifestMissingIds) ?? [];
  const yieldBearingMissingFromRankings = getStringArray(payload?.yieldBearingMissingFromRankings) ?? [];
  const headlineGaps: YieldCoverageAuditQueueItem[] = [
    ...manifestMissingIds.map((stablecoinId) => ({
      id: `manifest-missing:${stablecoinId}`,
      kind: "manifest-missing" as const,
      title: stablecoinId,
      detail: "Yield-bearing tracked asset has no adapter-manifest entry.",
      actionHint: "accept" as const,
      stablecoinIds: [stablecoinId],
    })),
    ...yieldBearingMissingFromRankings.map((stablecoinId) => ({
      id: `ranking-missing:${stablecoinId}`,
      kind: "ranking-missing" as const,
      title: stablecoinId,
      detail: "Manifest-covered yield-bearing asset is absent from the latest rankings cache.",
      actionHint: "watch" as const,
      stablecoinIds: [stablecoinId],
    })),
    ...objectArray(payload?.staleAutoLendingOverrides).map((row) =>
      legacyStaleAutoLendingOverrideQueueItem(row),
    ),
    ...objectArray(payload?.unmatchedHighTvlPools).map((row) =>
      legacyPoolQueueItem("unmatched-high-tvl-pool", row),
    ),
    ...objectArray(payload?.missingProtocols).map((row) =>
      legacyPoolQueueItem("missing-protocol", row),
    ),
  ].filter((item): item is YieldCoverageAuditQueueItem => item != null);

  const recommendationCandidates: YieldCoverageAuditQueueItem[] = [
    ...objectArray(payload?.nativeExactPoolRecommendations).map((row) =>
      legacyPoolQueueItem("native-exact-pool", row),
    ),
    ...objectArray(payload?.sourceFamilyAdapterRecommendations).map((row) =>
      legacyProtocolQueueItem("source-family-adapter", row),
    ),
    ...objectArray(payload?.lendingAllowlistRecommendations).map((row) =>
      legacyProtocolQueueItem("lending-allowlist", row),
    ),
    ...objectArray(payload?.staleVenueRiskScores).map((row) =>
      legacyStaleVenueRiskScoreQueueItem(row),
    ),
  ].filter((item): item is YieldCoverageAuditQueueItem => item != null);

  return {
    headlineGaps: headlineGaps.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
    recommendationCandidates: recommendationCandidates.slice(0, COVERAGE_AUDIT_QUEUE_ITEM_LIMIT),
    allowedActions: COVERAGE_AUDIT_QUEUE_ACTIONS,
    queuePersistence: "deferred",
  };
}

function buildSupplementalHealth(
  now: number,
  byKey: Map<string, CacheRow>,
): YieldHealthSummary["supplemental"] {
  const aggregateRow = byKey.get(YIELD_SUPPLEMENTAL_CACHE_KEY) ?? null;
  const aggregateAgeSec = ageSeconds(now, aggregateRow?.updated_at);
  const aggregateStatus = freshnessStatus(
    aggregateAgeSec,
    STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
    { missingIs: "unknown", degradedAfterOne: true },
  );

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
      updatedAt: aggregateRow?.updated_at ?? null,
      ageSec: aggregateAgeSec,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
      status: aggregateStatus,
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

export async function loadYieldHealthSummary(
  db: D1Database,
  now: number,
  crons: Record<string, CronStatus>,
): Promise<YieldHealthSummary> {
  const rows = await db
    .prepare(
      `SELECT key, value, updated_at
       FROM cache
       WHERE key IN ('yield-rankings', 'yield:supplemental-sources:v1', 'yield-coverage-audit')
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
    : freshnessStatus(rankingAgeSec, YIELD_RANKING_MAX_AGE_SEC, { missingIs: "stale" });
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
  const coverageAuditStatus = freshnessStatus(
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
  const coverageAuditQueue = buildCoverageAuditQueue(coverageAuditPayload);
  const comparisonAnchorFreshness = buildComparisonAnchorFreshnessSummary(crons);

  const status = worstStatus([
    rankingStatus,
    safetyCoverageStatus,
    supplemental.status,
    benchmarkRegistry.status,
    coverageAuditStatus,
    sourceRiskCoverage.status,
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
      ...coverageAuditCounts,
      ...coverageAuditQueue,
    },
    sourceRiskCoverage,
    comparisonAnchorFreshness,
    latestCronStatus: crons["sync-yield-data"]?.lastRun?.status ?? null,
    latestCronStartedAt: crons["sync-yield-data"]?.lastRun?.startedAt ?? null,
  };
}
