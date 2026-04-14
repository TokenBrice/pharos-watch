"use client";

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { YieldSourceLink } from "@/components/yield-source-link";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import { ALT_SOURCE_INITIAL_COUNT } from "@/components/yield-detail-section-model";
import type { AltYieldSource } from "@shared/types";

export interface YieldDetailSectionAltSourcesProps {
  altSources: AltYieldSource[];
  bestApy: number;
  bestSourceKey: string | null;
  onSelectSource: (sourceKey: string) => void;
  selectedSourceKeys: Set<string>;
  showAll: boolean;
  onShowAll: () => void;
}

export function YieldDetailSectionAltSources({
  altSources,
  bestApy,
  bestSourceKey,
  onSelectSource,
  selectedSourceKeys,
  showAll,
  onShowAll,
}: YieldDetailSectionAltSourcesProps) {
  const [sortField, setSortField] = useState<"apy" | "tvl">("apy");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (field: "apy" | "tvl") => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sorted = [...altSources].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "apy") return mul * (a.apy30d - b.apy30d);
    return mul * ((a.sourceTvlUsd ?? 0) - (b.sourceTvlUsd ?? 0));
  });

  const visible = showAll ? sorted : sorted.slice(0, ALT_SOURCE_INITIAL_COUNT);
  const hiddenCount = sorted.length - ALT_SOURCE_INITIAL_COUNT;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Alternative Sources
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="pb-2 text-left font-medium">Source</th>
              <th className="pb-2 text-center font-medium">Type</th>
              <th
                className="cursor-pointer pb-2 text-right font-medium transition-colors hover:text-foreground"
                onClick={() => toggleSort("apy")}
              >
                APY 30d {sortField === "apy" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="pb-2 text-right font-medium">vs Best</th>
              <th
                className="cursor-pointer pb-2 text-right font-medium transition-colors hover:text-foreground"
                onClick={() => toggleSort("tvl")}
              >
                TVL {sortField === "tvl" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="pb-2 text-center font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((source) => {
              const isSelected = selectedSourceKeys.has(source.sourceKey);
              const isBest = source.sourceKey === bestSourceKey;
              const delta = source.apy30d - bestApy;
              const deltaSign = delta >= 0 ? "+" : "";
              return (
                <tr
                  key={source.sourceKey}
                  className={cn(
                    "border-b border-border/30 transition-colors last:border-0",
                    isSelected && "bg-primary/5",
                  )}
                >
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <YieldSourceLink href={source.yieldSourceUrl} className="text-foreground">
                        {source.yieldSource}
                      </YieldSourceLink>
                      {isBest ? (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          Best
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-2 text-center">
                    <Badge variant="outline" className={cn("text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}>
                      {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                    </Badge>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">{formatPercent(source.apy30d)}</td>
                  <td className="py-2 text-right">
                    <span className={cn("font-mono tabular-nums text-[10px]", delta >= 0 ? "text-emerald-500" : "text-muted-foreground")}>
                      {deltaSign}
                      {formatPercent(delta)}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {source.sourceTvlUsd !== null ? formatCurrency(source.sourceTvlUsd) : "—"}
                  </td>
                  <td className="py-2 text-center">
                    <button
                      type="button"
                      onClick={() => onSelectSource(source.sourceKey)}
                      className={cn(
                        "pharos-focus-ring inline-flex items-center rounded-full p-1 transition-colors",
                        isSelected
                          ? "bg-primary/10 text-primary hover:bg-primary/20"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      aria-label={`${isSelected ? "Remove" : "Show"} ${source.yieldSource} on chart`}
                      title={isSelected ? "Remove from chart" : "Show on chart"}
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!showAll && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={onShowAll}
          className="mt-3 w-full rounded-lg border border-border/60 bg-background/55 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          Show {hiddenCount} more source{hiddenCount !== 1 ? "s" : ""}
        </button>
      ) : null}
    </div>
  );
}
