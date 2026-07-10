"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useYieldCompareSelection } from "@/hooks/use-yield-compare-selection";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableSourceLink } from "@/components/table/client";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { buildYieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceFreshness,
  formatYieldSourceRiskCompact,
} from "@/lib/yield-source-risk";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldSourceRiskCard } from "@/components/yield-source-risk-card";
import { YieldDecisionLedgerCard } from "@/components/yield-decision-ledger-card";
import { buildStablecoinUrl } from "@/lib/urls";
import { trackEvent } from "@/lib/analytics";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type { YieldRanking } from "@shared/types";

interface YieldSourceSheetProps {
  ranking: YieldRanking | null;
  logo: string | undefined;
  riskFreeRate: number;
  medianApy: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface YieldSourceSheetBodyProps {
  ranking: YieldRanking;
  logo: string | undefined;
  riskFreeRate: number;
  medianApy: number;
  onOpenChange: (open: boolean) => void;
}

function YieldSourceSheetBody({ ranking, logo, riskFreeRate, medianApy, onOpenChange }: YieldSourceSheetBodyProps) {
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [showAllSheetSources, setShowAllSheetSources] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const compare = useYieldCompareSelection();
  const alreadyInCompare = compare.has(ranking.id);
  const canAddToCompare = compare.canAdd;

  const sourceExplorer = buildYieldSourceExplorerModel(ranking);
  const effectiveSourceKey = selectedSourceKey ?? sourceExplorer.selectedSource.sourceKey;
  const totalSources = sourceExplorer.allSources.length;
  const { selectedSource } = sourceExplorer;
  const activeSource =
    sourceExplorer.allSources.find((source) => source.sourceKey === effectiveSourceKey) ?? selectedSource;
  const confidenceTier = ranking.provenance?.confidenceTier ?? null;
  const confidenceStyle = confidenceTier ? (YIELD_SOURCE_CONFIDENCE_STYLES[confidenceTier] ?? null) : null;
  const confidenceLabel = confidenceTier ? (YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier]?.label ?? null) : null;
  const freshness = classifyYieldSourceFreshness(ranking.sourceRisk?.sourceAgeSeconds ?? null);
  const hasAlternateSelected =
    selectedSourceKey !== null && selectedSourceKey !== sourceExplorer.selectedSource.sourceKey;
  const deepDiveSearch = hasAlternateSelected ? new URLSearchParams({ sources: selectedSourceKey }).toString() : "";
  const deepDiveHref = `${buildStablecoinUrl(ranking.id)}yield/${deepDiveSearch ? `?${deepDiveSearch}` : ""}`;

  const handleSourceClick = (sourceKey: string) => {
    setSelectedSourceKey(sourceKey);
    chartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <SheetContent side="right" className="sm:max-w-md overflow-y-auto">
      <TooltipProvider>
        <SheetHeader>
          <div className="flex items-center gap-3">
            <StablecoinLogo src={logo} name={ranking.name} size={32} />
            <div>
              <SheetTitle>{ranking.name}</SheetTitle>
              <SheetDescription>
                {totalSources} yield source observation{totalSources !== 1 ? "s" : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-4">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Chosen Yield Source
            </p>
            <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <TableSourceLink
                  href={selectedSource.url}
                  className="text-sm font-medium text-foreground"
                  onClick={() => {
                    trackEvent("yield_row_action", {
                      action: "provider_opened",
                      coin_id: ranking.id,
                      warning_count: ranking.warningSignals.length,
                    });
                  }}
                >
                  {selectedSource.displayLabel}
                </TableSourceLink>
                <Badge variant="outline" className={cn("text-xs", YIELD_TYPE_STYLES[ranking.yieldType]?.badge ?? "")}>
                  {YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType}
                </Badge>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono text-lg tabular-nums text-foreground">{formatPercent(ranking.apy30d)}</span>
                <YieldSourceRiskBar score={ranking.sourceRisk?.sourceRiskScore ?? null} tooltip />
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {selectedSource.sourceTvlUsd !== null && <span>TVL {formatCurrency(selectedSource.sourceTvlUsd)}</span>}
              {confidenceStyle && confidenceLabel && <span className={confidenceStyle.pill}>{confidenceLabel}</span>}
              <span
                className="rounded-full border border-border/60 bg-muted/20 px-1.5 py-0.5 text-[10px]"
                title={YIELD_SOURCE_DEPTH_DEFINITIONS[sourceExplorer.sourceDepthLens].description}
              >
                {YIELD_SOURCE_DEPTH_DEFINITIONS[sourceExplorer.sourceDepthLens].label} depth
              </span>
              {freshness && (
                <span
                  className={freshness.textClassName}
                  title={`Source observed ${freshness.relativeText} (${freshness.tier})`}
                >
                  {freshness.relativeText}
                </span>
              )}
              {sourceExplorer.sourceSwitch.changed ? (
                <span
                  className="rounded-full border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300"
                  title="The chosen source changed versus the prior published snapshot. This explains source provenance, not stablecoin safety."
                >
                  source changed
                </span>
              ) : null}
            </div>
            <YieldDecisionLedgerCard ledger={ranking.decisionLedger} variant="inline" className="mt-2" />
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <dt>Current source key:</dt>
                <dd className="font-mono text-[11px] text-foreground">{selectedSource.sourceKey}</dd>
              </div>
              {sourceExplorer.sourceSwitch.previousSourceKey ? (
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <dt>Previous source:</dt>
                  <dd>
                    <span className="text-foreground">
                      {sourceExplorer.sourceSwitch.previousSourceDisplayLabel ??
                        sourceExplorer.sourceSwitch.previousSourceKey}
                    </span>
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                      {sourceExplorer.sourceSwitch.previousSourceKey}
                    </span>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          <YieldSourceRiskCard
            sourceLabel={activeSource.displayLabel}
            sourceRisk={activeSource.sourceRisk}
            sourceTvlUsd={activeSource.sourceTvlUsd}
            sourceDepthLens={activeSource.depthLens}
            sourceRiskDrivers={activeSource.sourceRiskDrivers}
            sourceChanged={activeSource.isChosen ? sourceExplorer.sourceSwitch.changed : false}
            confidenceTier={activeSource.confidenceTier}
          />

          {sourceExplorer.retainedAlternates.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Retained alternates
              </p>
              <div className="mt-2 space-y-1.5">
                {[...sourceExplorer.retainedAlternates]
                  .sort((a, b) => b.apy30d - a.apy30d)
                  .slice(0, showAllSheetSources ? undefined : 6)
                  .map((source) => {
                    const isSelected = effectiveSourceKey === source.sourceKey;
                    const delta = source.apy30d - ranking.apy30d;
                    const deltaSign = delta >= 0 ? "+" : "";
                    const confidence = source.confidenceTier
                      ? (YIELD_SOURCE_CONFIDENCE_DEFINITIONS[source.confidenceTier]?.label ?? null)
                      : null;

                    return (
                      <button
                        key={source.sourceKey}
                        type="button"
                        onClick={() => handleSourceClick(source.sourceKey)}
                        className={cn(
                          "pharos-focus-ring flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 text-left transition-colors hover:bg-muted/30",
                          isSelected && "ring-1 ring-primary/40",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm text-foreground">{source.displayLabel}</span>
                            <Badge
                              variant="outline"
                              className={cn("shrink-0 text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                            >
                              {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                            </Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                            {confidence ? <span>{confidence}</span> : null}
                            <span title={YIELD_SOURCE_DEPTH_DEFINITIONS[source.depthLens].description}>
                              {YIELD_SOURCE_DEPTH_DEFINITIONS[source.depthLens].label} depth
                            </span>
                            <span className="font-mono tabular-nums">
                              Risk {formatYieldSourceRiskCompact(source.sourceRisk)}
                            </span>
                            {source.rejectionHint ? (
                              <span title={source.rejectionHint.description}>Reason {source.rejectionHint.label}</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 text-xs">
                          <span className="font-mono tabular-nums text-foreground">{formatPercent(source.apy30d)}</span>
                          <span
                            className={cn(
                              "font-mono tabular-nums text-[10px]",
                              delta >= 0 ? "text-emerald-500" : "text-muted-foreground",
                            )}
                          >
                            {deltaSign}
                            {formatPercent(delta)}
                          </span>
                          {source.sourceTvlUsd !== null && (
                            <span className="text-muted-foreground">{formatCurrency(source.sourceTvlUsd)}</span>
                          )}
                          {source.rejectionHint && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="rounded-full border border-slate-500/20 bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-700 dark:text-slate-300">
                                  {source.rejectionHint.label}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-[11px]">
                                Likely reason {source.rejectionHint.code}: {source.rejectionHint.description}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </button>
                    );
                  })}
              </div>
              {!showAllSheetSources && sourceExplorer.retainedAlternates.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllSheetSources(true)}
                  className="mt-2 w-full rounded-lg border border-border/60 bg-background/55 py-1.5 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
                >
                  Show {sourceExplorer.retainedAlternates.length - 6} more
                </button>
              )}
            </div>
          )}

          <div ref={chartRef} className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Showing{" "}
              <span className="font-medium text-foreground">
                {sourceExplorer.allSources.find((source) => source.sourceKey === effectiveSourceKey)?.displayLabel ??
                  "Best source"}
              </span>
            </p>
            <YieldHistoryChart
              stablecoinId={ranking.id}
              benchmarkRate={ranking.benchmarkRate ?? riskFreeRate}
              benchmarkLabel={ranking.benchmarkLabel}
              benchmarkIsFallback={ranking.benchmarkSelectionMode === "fallback-usd" || ranking.benchmarkIsFallback}
              medianApy={medianApy}
              compact
              availableSources={sourceExplorer.historySources}
              hideSourceSelector
              externalSourceKey={effectiveSourceKey}
            />
          </div>
        </div>

        <SheetFooter>
          {!alreadyInCompare && canAddToCompare ? (
            <button
              type="button"
              onClick={() => {
                compare.toggle(ranking.id);
                onOpenChange(false);
              }}
              className="pharos-focus-ring text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              + Compare with current view
            </button>
          ) : null}
          <Link
            href={deepDiveHref}
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => {
              trackEvent("yield_row_action", {
                action: "deep_dive_opened",
                coin_id: ranking.id,
                warning_count: ranking.warningSignals.length,
              });
              onOpenChange(false);
            }}
          >
            Deep dive yield &rarr;
          </Link>
          <Link
            href={buildStablecoinUrl(ranking.id)}
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onOpenChange(false)}
          >
            View full dossier &rarr;
          </Link>
        </SheetFooter>
      </TooltipProvider>
    </SheetContent>
  );
}

export function YieldSourceSheet({
  ranking,
  logo,
  riskFreeRate,
  medianApy,
  open,
  onOpenChange,
}: YieldSourceSheetProps) {
  if (!ranking) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <YieldSourceSheetBody
        key={`${ranking.id}:${open ? "open" : "closed"}`}
        ranking={ranking}
        logo={logo}
        riskFreeRate={riskFreeRate}
        medianApy={medianApy}
        onOpenChange={onOpenChange}
      />
    </Sheet>
  );
}
