"use client";

import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiquidityHealth, StatusSectionError } from "@shared/types";
import { formatCurrency } from "@shared/lib/format";
import { StatusCardEmptyState } from "@/components/status/page-primitives";

function guardTone(active: boolean): string {
  return active ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
}

function CoverageMix({
  title,
  classes,
}: {
  title: string;
  classes: Pick<LiquidityHealth["currentCoverageClasses"], "primary" | "mixed" | "fallback" | "unobserved">;
}) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>Primary: <span className="pharos-numeric">{classes.primary}</span></div>
        <div>Mixed: <span className="pharos-numeric">{classes.mixed}</span></div>
        <div>Fallback: <span className="pharos-numeric">{classes.fallback}</span></div>
        <div>Unobserved: <span className="pharos-numeric">{classes.unobserved}</span></div>
      </div>
    </div>
  );
}

export function LiquidityHealthCard({
  health,
  error,
}: {
  health: LiquidityHealth | null;
  error?: StatusSectionError;
}) {
  if (!health) {
    return (
      <StatusCardEmptyState title="Liquidity Health">
        {error ? `Liquidity health loader failed: ${error.message}` : "No liquidity health data available yet."}
      </StatusCardEmptyState>
    );
  }

  const currentClasses = health.currentCoverageClasses;
  const previousClasses = health.previousCoverageClasses;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Liquidity Health</CardTitle>
          <span className="text-xs text-muted-foreground">
            Last run {health.lastRunStatus ?? "unknown"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatTile
            label="Covered Coins"
            value={String(health.currentCoverage)}
            subtext={
              health.previousCoverage != null
                ? `prev ${health.previousCoverage}`
                : undefined
            }
          />
          <StatTile
            label="Global DEX TVL"
            value={health.currentGlobalTvl != null ? formatCurrency(health.currentGlobalTvl) : "—"}
            subtext={
              health.previousGlobalTvl != null
                ? `prev ${formatCurrency(health.previousGlobalTvl)}`
                : undefined
            }
          />
          <StatTile
            label="Top 10 Guard TVL"
            value={
              health.currentTop10GuardTvl != null
                ? formatCurrency(health.currentTop10GuardTvl)
                : health.currentTop10CoveredTvl != null
                  ? formatCurrency(health.currentTop10CoveredTvl)
                  : "—"
            }
            subtext={
              health.previousTop10GuardTvl != null
                ? `prev ${formatCurrency(health.previousTop10GuardTvl)}`
                : health.previousTop10CoveredTvl != null
                  ? `prev ${formatCurrency(health.previousTop10CoveredTvl)}`
                : undefined
            }
          />
          <StatTile
            label="Failed Sources"
            value={String(health.failedSources.length)}
            subtext={health.failedSources.length > 0 ? health.failedSources.join(", ") : "none"}
          />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className={guardTone(health.nearCoverageGuard)}>
            Row guard: {health.nearCoverageGuard
              ? `${health.currentCoverage}/${health.previousCoverage ?? "?"} (<80%)`
              : `${health.currentCoverage}/${health.previousCoverage ?? "?"}`}
          </span>
          <span className={guardTone(health.nearValueGuard)}>
            Value guard: {health.nearValueGuard
              ? `${health.currentGlobalTvl != null ? formatCurrency(health.currentGlobalTvl) : "?"}/${health.previousGlobalTvl != null ? formatCurrency(health.previousGlobalTvl) : "?"} (<85%)`
              : health.currentGlobalTvl != null && health.previousGlobalTvl != null
                ? `${formatCurrency(health.currentGlobalTvl)}/${formatCurrency(health.previousGlobalTvl)}`
                : "no data"}
          </span>
          <span className={guardTone(health.nearMajorCoverageGuard)}>
            Major guard: {health.nearMajorCoverageGuard
              ? `${health.currentTop10GuardTvl != null ? formatCurrency(health.currentTop10GuardTvl) : health.currentTop10CoveredTvl != null ? formatCurrency(health.currentTop10CoveredTvl) : "?"}/${health.previousTop10GuardTvl != null ? formatCurrency(health.previousTop10GuardTvl) : health.previousTop10CoveredTvl != null ? formatCurrency(health.previousTop10CoveredTvl) : "?"} (<85%)`
              : health.currentTop10GuardTvl != null && health.previousTop10GuardTvl != null
                ? `${formatCurrency(health.currentTop10GuardTvl)}/${formatCurrency(health.previousTop10GuardTvl)}`
                : health.currentTop10CoveredTvl != null && health.previousTop10CoveredTvl != null
                  ? `${formatCurrency(health.currentTop10CoveredTvl)}/${formatCurrency(health.previousTop10CoveredTvl)}`
                : "no data"}
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <CoverageMix title="Current coverage mix" classes={currentClasses} />
          <CoverageMix title="Previous coverage mix" classes={previousClasses} />
        </div>
      </CardContent>
    </Card>
  );
}
