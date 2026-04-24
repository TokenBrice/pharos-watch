"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

const CONFIDENCE_LABELS: Record<(typeof YIELD_SOURCE_CONFIDENCE_ORDER)[number], string> = {
  deterministic: "Deterministic",
  curated: "Curated",
  discovered: "Discovered",
  fallback: "Fallback",
};

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ApyTriplet({ summary, compact = false }: { summary: YieldSourceBoardApySummary | null; compact?: boolean }) {
  if (!summary) {
    return <span className="text-muted-foreground">No source-row APY</span>;
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
            {pluralize(group.representedSourceCount, "source row")}
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
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Selected</p>
          <p className="font-mono text-sm tabular-nums text-foreground">{group.selectedCount}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Alt</p>
          <p className="font-mono text-sm tabular-nums text-foreground">{group.alternateCount}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase text-muted-foreground">Source-row APY</p>
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
      label: CONFIDENCE_LABELS[tier],
      count: model.selectedConfidenceCounts[tier],
    }))
    .filter((entry) => entry.count > 0);

  return (
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
            Selected rows and retained alternatives from the live rankings payload, grouped by source family and yield type.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {model.sourceSwitchCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-700 dark:text-sky-300">
              {pluralize(model.sourceSwitchCount, "source switch", "source switches")}
            </span>
          ) : null}
          {model.anomalyCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              {pluralize(model.anomalyCount, "selected row")} with source anomalies
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)]">
        <div className="min-w-0">
          <div className="grid gap-x-5 gap-y-3 border-b border-border/60 px-4 py-4 sm:grid-cols-[1fr_1fr_1.3fr] sm:px-5">
            <dl className="grid grid-cols-3 gap-3">
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Selected</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.selectedCount}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Alt</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.alternateCount}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase text-muted-foreground">Source rows</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-foreground">{model.representedSourceCount}</dd>
              </div>
            </dl>
            <div>
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Source families</p>
              <p className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {model.representedDataSourceCount}
              </p>
              <p className="text-xs text-muted-foreground">{pluralize(model.groups.length, "source lane")}</p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Source-row APY</p>
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
            <p className="pharos-kicker">Selected-source confidence</p>
            {confidenceEntries.length > 0 ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {confidenceEntries.map((entry) => (
                  <div key={entry.tier} className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">{entry.label}</dt>
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
              <p className="text-sm text-muted-foreground">No selected-source confidence tiers reported.</p>
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

          <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
            Source-row APY is current payload context across selected and alternate rows. It is not an asset median,
            market median, investability rating, or safety signal.
          </p>
        </aside>
      </div>
    </section>
  );
}
