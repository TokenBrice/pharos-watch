"use client";

import { formatCompactUsd, formatElapsedSeconds, formatPercentFromRatio } from "@shared/lib/format";
import type {
  StatusSectionError,
  YieldCoverageAuditQueueItem,
  YieldHealthFieldStatus,
  YieldHealthSummary,
  YieldSourceRiskCoverageField,
  YieldSourceRiskFieldCoverage,
} from "@shared/types";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusCardEmptyState } from "@/components/status/page-primitives";
import { getStatusTone } from "@/lib/status-dashboard-model";

const SOURCE_RISK_COVERAGE_FIELDS = [
  ["sourceRiskPenalty", "Penalty"],
  ["rewardShare", "Rewards"],
  ["sourceAgeSeconds", "Age"],
  ["sourceDepthRatio", "Depth"],
  ["venueRiskTier", "Venue tier"],
  ["sourceRiskScore", "Score"],
  ["observationCount30d", "Observations"],
  ["sourceSwitchCount30d", "Switches"],
] satisfies Array<[YieldSourceRiskCoverageField, string]>;

function statusClassName(status: YieldHealthFieldStatus): string {
  // healthy/degraded/stale re-bin onto the dashboard's one status palette; the
  // fourth ("unknown") field state has no `StatusResponse` counterpart.
  if (status === "healthy" || status === "degraded" || status === "stale") {
    return getStatusTone(status).valueClassName;
  }
  return "text-muted-foreground";
}

function ageLabel(ageSec: number | null): string {
  return ageSec == null ? "unknown" : `${formatElapsedSeconds(ageSec)} ago`;
}

function supplementalSubtext(supplemental: YieldHealthSummary["supplemental"]): string {
  if (supplemental.familyCount && supplemental.familyCount > 0) {
    const fresh = supplemental.freshFamilyCount ?? 0;
    const degraded = supplemental.degradedFamilyCount ?? 0;
    const stale = supplemental.staleFamilyCount ?? 0;
    const missing = supplemental.missingFamilyCount ?? 0;
    return `${fresh}/${supplemental.familyCount} fresh · ${degraded} degraded · ${stale} stale · ${missing} missing`;
  }
  return ageLabel(supplemental.ageSec);
}

function benchmarkRegistrySubtext(registry: YieldHealthSummary["benchmarkRegistry"]): string {
  if (registry.usedBenchmarkCount === 0) return "no published benchmark usage";
  return `${registry.healthyBenchmarkCount}/${registry.usedBenchmarkCount} healthy · ${registry.degradedBenchmarkCount} degraded · ${registry.staleBenchmarkCount} stale · ${registry.unknownBenchmarkCount} unknown`;
}

function coverageStatus(
  field: YieldSourceRiskFieldCoverage | undefined,
  threshold: number,
): YieldHealthFieldStatus {
  if (!field || field.eligibleCount <= 0) return "unknown";
  return field.coverageRatio >= threshold ? "healthy" : "degraded";
}

function coverageSubtext(coverage: YieldHealthSummary["sourceRiskCoverage"]): string {
  if (coverage.totalRows <= 0) return "no ranking rows";
  return `${coverage.rowsWithSourceRisk}/${coverage.totalRows} rows with sourceRisk`;
}

function auditQueueSubtext(coverageAudit: YieldHealthSummary["coverageAudit"]): string {
  if (coverageAudit.headlineGapCount == null && coverageAudit.recommendationCandidateCount == null) {
    return "queue unavailable";
  }
  const stale = coverageAudit.staleAutoLendingOverrideCount ?? 0;
  const staleVenue = coverageAudit.staleVenueRiskScoreCount ?? 0;
  const staleParts = [
    ...(stale > 0 ? [`${stale} stale overrides`] : []),
    ...(staleVenue > 0 ? [`${staleVenue} venue reviews`] : []),
  ];
  const staleText = staleParts.length > 0 ? ` · ${staleParts.join(" · ")}` : "";
  return `${coverageAudit.headlineGapCount ?? 0} gaps · ${coverageAudit.recommendationCandidateCount ?? 0} candidates${staleText}`;
}

function rankingSubtext(health: YieldHealthSummary): string {
  const age = ageLabel(health.rankingAgeSec);
  if (health.rankingCountDelta == null || health.previousRankingCount == null) return age;
  const sign = health.rankingCountDelta > 0 ? "+" : "";
  return `${age} · ${sign}${health.rankingCountDelta} vs ${health.previousRankingCount}`;
}

function queueItemMeta(item: YieldCoverageAuditQueueItem): string {
  if (item.tvlUsd != null) {
    const apy = item.apy != null ? ` · ${item.apy.toFixed(2)}% APY` : "";
    return `${formatCompactUsd(item.tvlUsd)} TVL${apy}`;
  }
  if (item.totalTvlUsd != null) {
    const pools = item.poolCount != null ? ` · ${item.poolCount} pools` : "";
    return `${formatCompactUsd(item.totalTvlUsd)} TVL${pools}`;
  }
  if (item.stablecoinIds?.length) {
    return item.stablecoinIds.join(", ");
  }
  return item.kind.replaceAll("-", " ");
}

function QueueItems({
  title,
  items,
}: {
  title: string;
  items: YieldCoverageAuditQueueItem[];
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-md border border-border/40 p-2">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div>
                </div>
                <div className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                  {item.actionHint}
                </div>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {queueItemMeta(item)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/40 p-2 text-xs text-muted-foreground">No current items</div>
      )}
    </div>
  );
}

export function YieldHealthCard({
  health,
  error,
}: {
  health: YieldHealthSummary | null;
  error?: StatusSectionError;
}) {
  if (!health) {
    return (
      <StatusCardEmptyState title="Yield Health">
        {error ? `Yield health loader failed: ${error.message}` : "No yield health data available yet."}
      </StatusCardEmptyState>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Yield Health</CardTitle>
          <a
            href={health.runbookUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Runbook
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <StatTile
            label="Rankings"
            value={<span className={statusClassName(health.rankingStatus)}>{health.rankingCount ?? "-"}</span>}
            subtext={rankingSubtext(health)}
          />
          <StatTile
            label="Safety Coverage"
            value={
              <span className={statusClassName(health.safetyCoverage.status)}>
                {formatPercentFromRatio(health.safetyCoverage.coverageRatio, 1)}
              </span>
            }
            subtext={
              health.safetyCoverage.coveredCount == null || health.safetyCoverage.trackedCount == null
                ? "unknown"
                : `${health.safetyCoverage.coveredCount}/${health.safetyCoverage.trackedCount}`
            }
          />
          <StatTile
            label="Supplemental"
            value={<span className={statusClassName(health.supplemental.status)}>{health.supplemental.status}</span>}
            subtext={supplementalSubtext(health.supplemental)}
          />
          <StatTile
            label="Benchmarks"
            value={
              <span className={statusClassName(health.benchmarkRegistry.status)}>
                {health.benchmarkRegistry.status}
              </span>
            }
            subtext={benchmarkRegistrySubtext(health.benchmarkRegistry)}
          />
          <StatTile
            label="Source Risk"
            value={
              <span className={statusClassName(health.sourceRiskCoverage.status)}>
                {health.sourceRiskCoverage.status}
              </span>
            }
            subtext={coverageSubtext(health.sourceRiskCoverage)}
          />
        </div>

        <div className="rounded-lg border border-border/50 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Published benchmark health</div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Object.values(health.benchmarkRegistry.benchmarks).map((benchmark) => (
              <div key={benchmark.key} className="flex min-w-0 items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">
                  {benchmark.key} · {benchmark.rowCount} row{benchmark.rowCount === 1 ? "" : "s"}
                </span>
                <span className={`shrink-0 font-mono font-semibold ${statusClassName(benchmark.status)}`}>
                  {benchmark.status} · {ageLabel(benchmark.ageSec)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">Source-risk coverage</div>
            <div className="text-xs text-muted-foreground">
              Warn below {formatPercentFromRatio(health.sourceRiskCoverage.threshold, 0)}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {SOURCE_RISK_COVERAGE_FIELDS.map(([field, label]) => {
              const coverage = health.sourceRiskCoverage.fields[field];
              const fieldStatus = coverageStatus(coverage, health.sourceRiskCoverage.threshold);
              return (
                <div key={field} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={`font-mono font-semibold ${statusClassName(fieldStatus)}`}>
                    {coverage ? formatPercentFromRatio(coverage.coverageRatio, 0) : "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-border/50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">Coverage audit operator queue</div>
            <div className="text-xs text-muted-foreground">
              Actions: {health.coverageAudit.allowedActions.join(", ")}
            </div>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <QueueItems title="Headline gaps" items={health.coverageAudit.headlineGaps} />
            <QueueItems title="Recommendation candidates" items={health.coverageAudit.recommendationCandidates} />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Queue state: {health.coverageAudit.queuePersistence}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>
            Coverage audit:{" "}
            <span className={statusClassName(health.coverageAudit.status)}>
              {health.coverageAudit.status}
            </span>{" "}
            ({ageLabel(health.coverageAudit.ageSec)})
          </span>
          <span>
            Coverage queue: {auditQueueSubtext(health.coverageAudit)}
          </span>
          <span>
            Status impact: {health.statusImpact === "public-critical" ? "public critical" : "admin watch"}
          </span>
          <span>Latest cron: {health.latestCronStatus ?? "unknown"}</span>
        </div>
      </CardContent>
    </Card>
  );
}
