import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { STATUS_CACHE_RATIO_THRESHOLDS, STATUS_YIELD_HEALTH_THRESHOLDS } from "@shared/lib/status-thresholds";
import type {
  CronStatus,
  YieldHealthFieldStatus,
  YieldHealthSummary,
  YieldSourceRiskCoverageField,
  YieldSourceRiskCoverageSummary,
} from "@shared/types/status";
import { YIELD_SUPPLEMENTAL_CACHE_KEY, getYieldSupplementalFamilyCacheKey } from "../../cron/yield-sync/cache";
import { SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "../../cron/yield-sync/supplemental-source-families";

const YIELD_RUNBOOK_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/yield-health.md";
const YIELD_RANKINGS_CACHE_KEY = "yield-rankings";
const YIELD_COVERAGE_AUDIT_CACHE_KEY = "yield-coverage-audit";
const YIELD_RANKING_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];
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

interface CacheRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

function safeJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
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

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

  return {
    totalRows: sourceRows.length,
    bestRows: sourceRows.filter((row) => row.isBest).length,
    altRows: sourceRows.filter((row) => !row.isBest).length,
    rowsWithSourceRisk: sourceRows.filter((row) => row.sourceRisk != null).length,
    fields,
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
    const payload = safeJson(row?.value ?? null);
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

  if (!familyRows.some((row) => row.updatedAt != null)) {
    return {
      updatedAt: aggregateRow?.updated_at ?? null,
      ageSec: aggregateAgeSec,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
      status: aggregateStatus,
      familyCount: 0,
      freshFamilyCount: 0,
      degradedFamilyCount: 0,
      staleFamilyCount: 0,
      missingFamilyCount: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
      families: Object.fromEntries(
        familyRows.map((row) => [
          row.family,
          {
            updatedAt: row.updatedAt,
            ageSec: row.ageSec,
            sourceCount: row.sourceCount,
            status: row.status,
          },
        ]),
      ),
    };
  }

  const familyStatuses = familyRows.map((row) => row.status);
  const latestFamilyUpdatedAt = Math.max(
    ...familyRows.map((row) => row.updatedAt ?? 0),
  ) || null;
  return {
    updatedAt: latestFamilyUpdatedAt,
    ageSec: ageSeconds(now, latestFamilyUpdatedAt),
    maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
    status: worstStatus(familyStatuses),
    familyCount: familyRows.length,
    freshFamilyCount: familyRows.filter((row) => row.status === "healthy").length,
    degradedFamilyCount: familyRows.filter((row) => row.status === "degraded").length,
    staleFamilyCount: familyRows.filter((row) => row.status === "stale").length,
    missingFamilyCount: familyRows.filter((row) => row.status === "unknown").length,
    families: Object.fromEntries(
      familyRows.map((row) => [
        row.family,
        {
          updatedAt: row.updatedAt,
          ageSec: row.ageSec,
          sourceCount: row.sourceCount,
          status: row.status,
        },
      ]),
    ),
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
  const rankingsPayload = safeJson(rankingsRow?.value ?? null);
  const rankingUpdatedAt = rankingsRow?.updated_at ?? getNumber(rankingsPayload?.updatedAt);
  const rankingAgeSec = ageSeconds(now, rankingUpdatedAt);
  const rankingStatus = rankingsPayload == null
    ? "stale"
    : freshnessStatus(rankingAgeSec, YIELD_RANKING_MAX_AGE_SEC, { missingIs: "stale" });
  const rankings = Array.isArray(rankingsPayload?.rankings) ? rankingsPayload.rankings : null;
  const sourceRiskCoverage = buildSourceRiskCoverage(rankings);

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
  const benchmarkAgeSec = getNumber(benchmark?.ageSeconds) ?? ageSeconds(now, benchmarkFetchedAt);
  const benchmarkIsFallback = getBoolean(benchmark?.isFallback);
  const benchmarkStaleness = freshnessStatus(
    benchmarkAgeSec,
    STATUS_YIELD_HEALTH_THRESHOLDS.benchmarkMaxAgeSec,
    { missingIs: "unknown", degradedAfterOne: true },
  );
  const benchmarkStatus: YieldHealthFieldStatus = benchmarkIsFallback === true
    ? (benchmarkStaleness === "stale" ? "stale" : "degraded")
    : benchmarkStaleness;

  const coverageAuditUpdatedAt = byKey.get(YIELD_COVERAGE_AUDIT_CACHE_KEY)?.updated_at ?? null;
  const coverageAuditAgeSec = ageSeconds(now, coverageAuditUpdatedAt);
  const coverageAuditStatus = freshnessStatus(
    coverageAuditAgeSec,
    STATUS_YIELD_HEALTH_THRESHOLDS.coverageAuditMaxAgeSec,
    { missingIs: "unknown", degradedAfterOne: true },
  );

  const status = worstStatus([
    rankingStatus,
    safetyCoverageStatus,
    supplemental.status,
    benchmarkStatus,
    coverageAuditStatus,
  ]);

  return {
    status,
    statusImpact: rankingStatus === "stale" ? "public-critical" : "admin-watch",
    runbookUrl: YIELD_RUNBOOK_URL,
    rankingCount: rankings?.length ?? null,
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
    coverageAudit: {
      updatedAt: coverageAuditUpdatedAt,
      ageSec: coverageAuditAgeSec,
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.coverageAuditMaxAgeSec,
      status: coverageAuditStatus,
    },
    sourceRiskCoverage,
    latestCronStatus: crons["sync-yield-data"]?.lastRun?.status ?? null,
    latestCronStartedAt: crons["sync-yield-data"]?.lastRun?.startedAt ?? null,
  };
}
