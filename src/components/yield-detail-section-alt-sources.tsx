"use client";

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { YieldSourceLink } from "@/components/yield-source-link";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import { ALT_SOURCE_INITIAL_COUNT } from "@/components/yield-detail-section-model";
import type { YieldSourceExplorerSource } from "@/lib/yield-source-explorer-model";

export interface YieldDetailSectionAltSourcesProps {
  altSources: YieldSourceExplorerSource[];
  bestApy: number;
  bestSourceKey: string | null;
  totalSourceCount?: number;
  onSelectSource: (sourceKey: string) => void;
  selectedSourceKeys: Set<string>;
  showAll: boolean;
  onShowAll: () => void;
}

export function YieldDetailSectionAltSources({
  altSources,
  bestApy,
  bestSourceKey,
  totalSourceCount,
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
  const getAriaSort = (field: "apy" | "tvl") => {
    if (sortField !== field) return "none";
    return sortDir === "asc" ? "ascending" : "descending";
  };
  const getSortIndicator = (field: "apy" | "tvl") => {
    if (sortField !== field) return "";
    return sortDir === "desc" ? "↓" : "↑";
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Retained alternates</p>
        {totalSourceCount && totalSourceCount > 1 ? (
          <p className="text-[11px] text-muted-foreground/80">
            {totalSourceCount} sources tracked · canonical chosen by confidence, not highest APY
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex gap-2 md:hidden" aria-label="Sort retained yield sources">
        <button
          type="button"
          onClick={() => toggleSort("apy")}
          className={cn(
            "pharos-focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border/60 bg-background/55 px-3 text-xs font-medium text-muted-foreground",
            sortField === "apy" && "text-foreground",
          )}
        >
          APY {sortField === "apy" ? (sortDir === "desc" ? "↓" : "↑") : ""}
        </button>
        <button
          type="button"
          onClick={() => toggleSort("tvl")}
          className={cn(
            "pharos-focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border/60 bg-background/55 px-3 text-xs font-medium text-muted-foreground",
            sortField === "tvl" && "text-foreground",
          )}
        >
          TVL {sortField === "tvl" ? (sortDir === "desc" ? "↓" : "↑") : ""}
        </button>
      </div>
      <ol className="mt-3 space-y-2 md:hidden" aria-label="Compact retained yield sources">
        {visible.map((source) => {
          const isSelected = selectedSourceKeys.has(source.sourceKey);
          const isBest = source.sourceKey === bestSourceKey;
          const delta = source.apy30d - bestApy;
          const deltaSign = delta >= 0 ? "+" : "";
          return (
            <li
              key={source.sourceKey}
              className={cn(
                "rounded-lg border border-border/60 bg-background/55 px-3 py-2",
                isSelected && "border-primary/40 bg-primary/5",
              )}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <YieldSourceLink
                      href={source.url}
                      className="max-w-full truncate text-sm font-medium text-foreground"
                    >
                      {source.displayLabel}
                    </YieldSourceLink>
                    {isBest ? (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                        Best
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                    >
                      {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                    </Badge>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      TVL {source.sourceTvlUsd !== null ? formatCurrency(source.sourceTvlUsd) : "—"}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm font-semibold tabular-nums">{formatPercent(source.apy30d)}</p>
                  <p
                    className={cn(
                      "mt-0.5 font-mono text-[11px] tabular-nums",
                      delta >= 0 ? "text-emerald-500" : "text-muted-foreground",
                    )}
                  >
                    {deltaSign}
                    {formatPercent(delta)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelectSource(source.sourceKey)}
                className={cn(
                  "pharos-focus-ring mt-2 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border/60 text-xs transition-colors",
                  isSelected
                    ? "bg-primary/10 text-primary hover:bg-primary/20"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                aria-label={`${isSelected ? "Remove" : "Show"} ${source.displayLabel} in compact chart`}
              >
                <BarChart3 className="h-3.5 w-3.5" />
                {isSelected ? "Remove from chart" : "Show on chart"}
              </button>
            </li>
          );
        })}
      </ol>
      <TableFrame
        tableId="yield-detail-alt-sources"
        testId="yield-detail-alt-sources-table"
        chrome="bare"
        density="compact"
        className="mt-3 hidden md:block"
        tableClassName="text-xs"
        tableProps={{ "aria-label": "Retained alternate yield sources" }}
        viewportProps={{ mobileScrollHint: false, compactBottomPadding: false }}
      >
        <TableHeader>
          <TableRow className="border-b border-border/40 text-muted-foreground hover:bg-transparent">
            <TableHead scope="col" className="h-auto px-0 pb-2 text-left font-medium">
              Source
            </TableHead>
            <TableHead scope="col" className="h-auto px-0 pb-2 text-center font-medium">
              Type
            </TableHead>
            <TableHead
              scope="col"
              aria-sort={getAriaSort("apy")}
              className="h-auto px-0 pb-2 text-right font-medium"
            >
              <button
                type="button"
                className="pharos-focus-ring inline-flex rounded-sm text-right transition-colors hover:text-foreground"
                onClick={() => toggleSort("apy")}
                aria-label={`Sort alternate sources by APY 30d ${
                  sortField === "apy" && sortDir === "desc" ? "ascending" : "descending"
                }`}
              >
                APY 30d {getSortIndicator("apy")}
              </button>
            </TableHead>
            <TableHead
              scope="col"
              className="h-auto px-0 pb-2 text-right font-medium"
              title="Difference vs the canonical source's 30d APY. Positive means this alternate has a higher APY than the canonical — but canonical selection weights confidence, not raw APY."
            >
              Δ APY
            </TableHead>
            <TableHead
              scope="col"
              aria-sort={getAriaSort("tvl")}
              className="h-auto px-0 pb-2 text-right font-medium"
            >
              <button
                type="button"
                className="pharos-focus-ring inline-flex rounded-sm text-right transition-colors hover:text-foreground"
                onClick={() => toggleSort("tvl")}
                aria-label={`Sort alternate sources by TVL ${
                  sortField === "tvl" && sortDir === "desc" ? "ascending" : "descending"
                }`}
              >
                TVL {getSortIndicator("tvl")}
              </button>
            </TableHead>
            <TableHead scope="col" className="h-auto px-0 pb-2 text-center font-medium">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((source) => {
            const isSelected = selectedSourceKeys.has(source.sourceKey);
            const isBest = source.sourceKey === bestSourceKey;
            const delta = source.apy30d - bestApy;
            const deltaSign = delta >= 0 ? "+" : "";
            return (
              <TableRow
                key={source.sourceKey}
                className={cn(
                  "border-b border-border/30 transition-colors last:border-0",
                  isSelected && "bg-primary/5",
                )}
              >
                <TableCell className="px-0 py-2 pr-2">
                  <div className="flex items-center gap-1.5">
                    <YieldSourceLink href={source.url} className="text-foreground">
                      {source.displayLabel}
                    </YieldSourceLink>
                    {isBest ? (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                        Best
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="px-0 py-2 text-center">
                  <Badge
                    variant="outline"
                    className={cn("text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                  >
                    {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                  </Badge>
                </TableCell>
                <TableCell className="px-0 py-2 text-right font-mono tabular-nums">
                  {formatPercent(source.apy30d)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right">
                  <span
                    className={cn(
                      "font-mono tabular-nums text-[10px]",
                      delta >= 0 ? "text-emerald-500" : "text-muted-foreground",
                    )}
                  >
                    {deltaSign}
                    {formatPercent(delta)}
                  </span>
                </TableCell>
                <TableCell className="px-0 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {source.sourceTvlUsd !== null ? formatCurrency(source.sourceTvlUsd) : "—"}
                </TableCell>
                <TableCell className="px-0 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => onSelectSource(source.sourceKey)}
                    className={cn(
                      "pharos-focus-ring inline-flex items-center rounded-full p-1 transition-colors",
                      isSelected
                        ? "bg-primary/10 text-primary hover:bg-primary/20"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    aria-label={`${isSelected ? "Remove" : "Show"} ${source.displayLabel} on chart`}
                    title={isSelected ? "Remove from chart" : "Show on chart"}
                  >
                    <BarChart3 className="h-3.5 w-3.5" />
                  </button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </TableFrame>
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
