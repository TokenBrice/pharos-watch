"use client";

import { formatElapsedSeconds, formatPercentFromRatio } from "@shared/lib/format";
import type { StatusSectionError, YieldHealthFieldStatus, YieldHealthSummary } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusMetricCard } from "./status-metric-card";

function statusClassName(status: YieldHealthFieldStatus): string {
  if (status === "healthy") return "text-green-700 dark:text-green-400";
  if (status === "degraded") return "text-amber-700 dark:text-amber-400";
  if (status === "stale") return "text-red-700 dark:text-red-400";
  return "text-muted-foreground";
}

function ageLabel(ageSec: number | null): string {
  return ageSec == null ? "unknown" : `${formatElapsedSeconds(ageSec)} ago`;
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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Yield Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error ? `Yield health loader failed: ${error.message}` : "No yield health data available yet."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Yield Health</CardTitle>
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
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatusMetricCard
            label="Rankings"
            value={<span className={statusClassName(health.rankingStatus)}>{health.rankingCount ?? "-"}</span>}
            subtext={ageLabel(health.rankingAgeSec)}
          />
          <StatusMetricCard
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
          <StatusMetricCard
            label="Supplemental"
            value={<span className={statusClassName(health.supplemental.status)}>{health.supplemental.status}</span>}
            subtext={ageLabel(health.supplemental.ageSec)}
          />
          <StatusMetricCard
            label="Benchmark"
            value={<span className={statusClassName(health.benchmark.status)}>{health.benchmark.status}</span>}
            subtext={
              health.benchmark.isFallback
                ? `fallback ${health.benchmark.fallbackMode ?? "active"}`
                : `${health.benchmark.source ?? "source"} · ${ageLabel(health.benchmark.ageSec)}`
            }
          />
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
            Status impact: {health.statusImpact === "public-critical" ? "public critical" : "admin watch"}
          </span>
          <span>Latest cron: {health.latestCronStatus ?? "unknown"}</span>
        </div>
      </CardContent>
    </Card>
  );
}
