"use client";

import { useEffect, useRef, useState } from "react";
// useRef needed for chartRef
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldSourceLink } from "@/components/yield-source-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

export function YieldSourceSheet({
  ranking,
  logo,
  riskFreeRate,
  medianApy,
  open,
  onOpenChange,
}: YieldSourceSheetProps) {
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [showAllSheetSources, setShowAllSheetSources] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  // Reset source selection when sheet opens for a different coin
  const currentId = ranking?.id ?? null;
  useEffect(() => {
    setSelectedSourceKey(null);
    setShowAllSheetSources(false);
  }, [currentId]);

  if (!ranking) return null;

  const bestSourceKey = ranking.provenance?.sourceKey ?? null;
  const effectiveSourceKey = selectedSourceKey ?? bestSourceKey ?? "best";
  const totalSources = 1 + (ranking.altSources?.length ?? 0);

  const allSources = [
    ...(bestSourceKey
      ? [{ sourceKey: bestSourceKey, yieldSource: ranking.yieldSource }]
      : []),
    ...(ranking.altSources ?? []).map((s) => ({
      sourceKey: s.sourceKey,
      yieldSource: s.yieldSource,
    })),
  ];

  const handleSourceClick = (sourceKey: string) => {
    setSelectedSourceKey(sourceKey);
    chartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md overflow-y-auto"
      >
        <SheetHeader>
          <div className="flex items-center gap-3">
            <StablecoinLogo src={logo} name={ranking.name} size={32} />
            <div>
              <SheetTitle>{ranking.name}</SheetTitle>
              <SheetDescription>
                {totalSources} yield source{totalSources !== 1 ? "s" : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-4">
          {/* Best source card */}
          <div className="rounded-xl border border-border/60 border-l-[3px] border-l-emerald-500 bg-background/55 px-3 py-2.5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Best Source
            </p>
            <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <YieldSourceLink href={ranking.yieldSourceUrl} className="text-sm font-medium text-foreground">
                  {ranking.yieldSource}
                </YieldSourceLink>
                <Badge
                  variant="outline"
                  className={cn("text-xs", YIELD_TYPE_STYLES[ranking.yieldType]?.badge ?? "")}
                >
                  {YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType}
                </Badge>
              </div>
              <span className="font-mono text-lg tabular-nums text-foreground">
                {formatPercent(ranking.apy30d)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {ranking.sourceTvlUsd !== null && (
                <span>TVL {formatCurrency(ranking.sourceTvlUsd)}</span>
              )}
              {ranking.provenance?.confidenceTier && (
                <span className="rounded-full border border-border/60 bg-muted/20 px-1.5 py-0.5 text-[10px]">
                  {ranking.provenance.confidenceTier}
                </span>
              )}
            </div>
          </div>

          {/* Alternative sources */}
          {(ranking.altSources?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Alternative Sources
              </p>
              <div className="mt-2 space-y-1.5">
                {[...ranking.altSources]
                  .sort((a, b) => b.apy30d - a.apy30d)
                  .slice(0, showAllSheetSources ? undefined : 6)
                  .map((source) => {
                  const isSelected = effectiveSourceKey === source.sourceKey;
                  const delta = source.apy30d - ranking.apy30d;
                  const deltaSign = delta >= 0 ? "+" : "";
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
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-foreground">{source.yieldSource}</span>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0 text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                        >
                          {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <span className="font-mono tabular-nums text-foreground">
                          {formatPercent(source.apy30d)}
                        </span>
                        <span className={cn("font-mono tabular-nums text-[10px]", delta >= 0 ? "text-emerald-500" : "text-muted-foreground")}>
                          {deltaSign}{formatPercent(delta)}
                        </span>
                        {source.sourceTvlUsd !== null && (
                          <span className="text-muted-foreground">
                            {formatCurrency(source.sourceTvlUsd)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!showAllSheetSources && ranking.altSources.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllSheetSources(true)}
                  className="mt-2 w-full rounded-lg border border-border/60 bg-background/55 py-1.5 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
                >
                  Show {ranking.altSources.length - 6} more
                </button>
              )}
            </div>
          )}

          {/* Inline history chart */}
          <div ref={chartRef} className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Showing:{" "}
              <span className="font-medium text-foreground">
                {allSources.find((s) => s.sourceKey === effectiveSourceKey)?.yieldSource ?? "Best source"}
              </span>
            </p>
            <YieldHistoryChart
              stablecoinId={ranking.id}
              benchmarkRate={ranking.benchmarkRate ?? riskFreeRate}
              benchmarkLabel={ranking.benchmarkLabel}
              benchmarkIsFallback={
                ranking.benchmarkSelectionMode === "fallback-usd" || ranking.benchmarkIsFallback
              }
              medianApy={medianApy}
              compact
              availableSources={allSources}
              hideSourceSelector
              externalSourceKey={effectiveSourceKey}
            />
          </div>
        </div>

        <SheetFooter>
          <Link
            href={`/stablecoin/${ranking.id}`}
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onOpenChange(false)}
          >
            View full dossier &rarr;
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
