"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
} from "@/lib/yield-source-risk";
import { formatPercent } from "@shared/lib/format";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import {
  YIELD_SOURCE_CONFIDENCE_ORDER,
  type YieldSourceBoardApySummary,
  type YieldSourceBoardGroup,
  type YieldSourceBoardModel,
} from "@/app/yield/source-board-model";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function InfoBadge({
  children,
  description,
  className,
}: {
  children: ReactNode;
  description: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "pharos-focus-ring inline-flex cursor-help items-center rounded-full border px-2 py-1 text-xs font-medium",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs">{description}</TooltipContent>
    </Tooltip>
  );
}

function ApyTriplet({ summary, compact = false }: { summary: YieldSourceBoardApySummary | null; compact?: boolean }) {
  if (!summary) {
    return <span className="text-muted-foreground">No observation APY</span>;
  }

  if (compact) {
    return (
      <span className="font-mono tabular-nums text-foreground">
        {formatPercent(summary.min)} / {formatPercent(summary.median)} / {formatPercent(summary.max)}
      </span>
    );
  }

  return (
    <dl className="grid grid-cols-3 gap-3 text-right">
      <div>
        <dt className="text-[10px] font-medium uppercase text-muted-foreground">Min</dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">{formatPercent(summary.min)}</dd>
      </div>
      <div>
        <dt className="text-[10px] font-medium uppercase text-muted-foreground">Median</dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">{formatPercent(summary.median)}</dd>
      </div>
      <div>
        <dt className="text-[10px] font-medium uppercase text-muted-foreground">Max</dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">{formatPercent(summary.max)}</dd>
      </div>
    </dl>
  );
}

function SourceGroupRow({ group }: { group: YieldSourceBoardGroup }) {
  const visibleSources = group.sourceLabels.slice(0, 3);
  const hiddenSourceCount = group.sourceLabels.slice(3).reduce((sum, source) => sum + source.count, 0);

  return (
    <li className="grid min-h-11 grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(190px,0.55fr)] sm:px-5">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn("text-[11px]", YIELD_TYPE_STYLES[group.yieldType]?.badge ?? "")}
          >
            {group.yieldTypeLabel}
          </Badge>
          <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {pluralize(group.representedSourceCount, "source observation")}
          </span>
        </div>
        {visibleSources.length > 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {visibleSources.map((source) => `${source.label}${source.count > 1 ? ` x${source.count}` : ""}`).join(", ")}
            {hiddenSourceCount > 0 ? `, +${hiddenSourceCount} more` : ""}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-3 text-left sm:text-right">
        <div>
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Chosen sources</p>
          <p className="font-mono text-sm tabular-nums text-foreground">{group.selectedCount}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Retained alternates</p>
          <p className="font-mono text-sm tabular-nums text-foreground">{group.alternateCount}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Observation APY</p>
          <ApyTriplet summary={group.apy} compact />
        </div>
      </div>
    </li>
  );
}

export function YieldSourceBoard({ model }: YieldSourceBoardProps) {
  if (model.representedSourceCount === 0) return null;

  const confidenceEntries = YIELD_SOURCE_CONFIDENCE_ORDER
    .map((tier) => ({
      tier,
      label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label,
      count: model.selectedConfidenceCounts[tier],
    }))
    .filter((entry) => entry.count > 0);

  return (
      <TooltipProvider>
        <section
          aria-labelledby="yield-source-board-heading"
          className="pharos-card-shell overflow-hidden"
        >
      <div className="pharos-panel-header flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Yield Sources</p>
          <h2 id="yield-source-board-heading" className="text-lg font-semibold tracking-tight text-foreground">
            Source provenance in the current view
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Counts every chosen source plus retained alternates for the rows currently visible. This is provenance
            coverage, not a recommendation ranking.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {model.sourceSwitchCount > 0 ? (
            <InfoBadge
              className="border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
              description="A source changed when the selected source differs from the prior published snapshot. It explains provenance churn, not a change in stablecoin safety."
            >
              {pluralize(model.sourceSwitchCount, "source changed", "sources changed")}
            </InfoBadge>
          ) : null}
          {model.anomalyCount > 0 ? (
            <InfoBadge
              className="border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              description="Anomalies flag source-observation quality issues such as low venue TVL or APY that diverges from recent history. Inspect the source sheet before treating the row as durable."
            >
              {pluralize(model.anomalyCount, "chosen source")} with anomalies
            </InfoBadge>
          ) : null}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)]">
        <div className="min-w-0">
          <div className="grid gap-x-5 gap-y-3 border-b border-border/60 px-4 py-4 sm:grid-cols-[1fr_1fr_1.3fr] sm:px-5">
            <dl className="grid grid-cols-3 gap-3">
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Chosen sources</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.selectedCount}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Retained alternates</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.alternateCount}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Source observations</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.representedSourceCount}</dd>
              </div>
            </dl>
            <div>
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Data families</p>
              <p className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {model.representedDataSourceCount}
              </p>
              <p className="text-xs text-muted-foreground">{pluralize(model.groups.length, "source lane")}</p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Observation APY</p>
              <ApyTriplet summary={model.sourceRowApy} />
            </div>
          </div>

          <ul className="divide-y divide-border/60" aria-label="Yield source groups">
            {model.groups.map((group) => (
              <SourceGroupRow key={group.key} group={group} />
            ))}
          </ul>
        </div>

        <aside className="space-y-4 border-t border-border/60 px-4 py-4 sm:px-5 lg:border-l lg:border-t-0">
          <div className="space-y-2">
            <p className="pharos-kicker">Chosen-source confidence</p>
            {confidenceEntries.length > 0 ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {confidenceEntries.map((entry) => (
                  <div key={entry.tier} className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted-foreground" title={YIELD_SOURCE_CONFIDENCE_DEFINITIONS[entry.tier].description}>
                      {entry.label}
                    </dt>
                    <dd className="font-mono text-sm tabular-nums text-foreground">{entry.count}</dd>
                  </div>
                ))}
                {model.selectedConfidenceUnknownCount > 0 ? (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">Unreported</dt>
                    <dd className="font-mono text-sm tabular-nums text-foreground">
                      {model.selectedConfidenceUnknownCount}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No chosen-source confidence tiers reported.</p>
            )}
          </div>

          {model.benchmarkLabels.length > 0 ? (
            <div className="space-y-2">
              <p className="pharos-kicker">Benchmarks in view</p>
              <ul className="space-y-1.5 text-sm">
                {model.benchmarkLabels.map((benchmark) => (
                  <li key={benchmark.label} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-muted-foreground">{benchmark.label}</span>
                    <span className="font-mono text-xs tabular-nums text-foreground">
                      {pluralize(benchmark.count, "selected row")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="pharos-kicker">Depth lens</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {(["deep", "moderate", "thin", "unknown"] as const).map((depth) => (
                <div key={depth} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground" title={YIELD_SOURCE_DEPTH_DEFINITIONS[depth].description}>
                    {YIELD_SOURCE_DEPTH_DEFINITIONS[depth].label}
                  </dt>
                  <dd className="font-mono text-sm tabular-nums text-foreground">{model.depthCounts[depth]}</dd>
                </div>
              ))}
            </dl>
          </div>

          <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
            Observation APY is current payload context across chosen and alternate source observations. Depth is
            venue context, not guaranteed executable capacity. Neither is an asset median, market median, investability
            rating, or safety signal.
          </p>
        </aside>
      </div>
      </section>
    </TooltipProvider>
  );
}
