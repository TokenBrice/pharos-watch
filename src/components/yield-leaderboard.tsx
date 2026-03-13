"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { YieldSourceLink } from "@/components/yield-source-link";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { formatCurrency, formatScore, formatPercent } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type { YieldRanking, AltYieldSource, YieldType } from "@shared/types";
import { formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { MethodologyLabel } from "@/components/methodology-hint";

const COLUMN_COUNT = 12;

const YIELD_COLUMNS: readonly DataTableColumn<YieldTableSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "coin", label: "Coin", className: "w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "apy30d", label: "APY (30d)", sortKey: "apy30d", className: "text-right", title: "30-day average annual percentage yield" },
  { id: "safety", label: "Safety", className: "hidden md:table-cell text-center", title: "Pharos Safety Grade / Score" },
  {
    id: "pys",
    label: <MethodologyLabel topic="pys">PYS</MethodologyLabel>,
    sortKey: "pys",
    className: "text-right",
    title: "Pharos Yield Score: risk-adjusted yield ranking",
  },
  { id: "source", label: "Source", className: "hidden sm:table-cell text-left" },
  { id: "yieldType", label: "Type", sortKey: "yieldType", className: "hidden sm:table-cell text-center", title: "Yield mechanism type" },
  { id: "tvl", label: "TVL", sortKey: "tvl", className: "hidden lg:table-cell text-right", title: "Total value locked in yield source" },
  {
    id: "yieldStability",
    label: <MethodologyLabel topic="yieldStability">Stability</MethodologyLabel>,
    sortKey: "yieldStability",
    className: "hidden lg:table-cell text-right",
    title: "Yield stability over 30 days (0-100%)",
  },
  { id: "range30d", label: "30d Range", className: "hidden xl:table-cell text-right" },
  { id: "signals", label: <MethodologyLabel topic="yieldWarnings">Signals</MethodologyLabel>, className: "hidden md:table-cell text-center" },
  { id: "expand", label: <span className="sr-only">Expand row</span>, className: "w-[44px] text-right" },
] as const;

/** Small pill badge that opens an inline popover listing alternative yield sources. */
function AltSourcesPopover({ altSources }: { altSources: AltYieldSource[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }
        }}
        className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        aria-label={`${altSources.length} alternative yield source${altSources.length > 1 ? "s" : ""}`}
        aria-expanded={open}
      >
        +{altSources.length}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border bg-card shadow-lg p-2 text-xs">
          <p className="text-muted-foreground mb-1.5 font-medium">Alt sources</p>
          {altSources.map((src) => (
            <div key={src.sourceKey} className="flex items-center justify-between gap-2 py-1 border-b last:border-0">
              <YieldSourceLink href={src.yieldSourceUrl} className="max-w-[180px] text-foreground" stopPropagation>
                {src.yieldSource}
              </YieldSourceLink>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 shrink-0">
                {formatPercent(src.currentApy)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface YieldLeaderboardProps {
  rankings: YieldRanking[];
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
}

export function YieldLeaderboard({ rankings, logos, riskFreeRate, medianApy }: YieldLeaderboardProps) {
  // Filter state tracks by display label so that types sharing a label (e.g. "lending-vault"
  // and "governance-set" both labeled "Native") are toggled together as one pill.
  const getLabel = (type: YieldType) => YIELD_TYPE_LABELS[type] ?? type;
  const [activeLabels, setActiveLabels] = useState<Set<string>>(
    () => new Set(Object.values(YIELD_TYPE_LABELS)),
  );
  const [hideWarnings, setHideWarnings] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visibleLabels = [...new Set(rankings.map((r) => getLabel(r.yieldType)))];
  const typeFiltered = rankings.filter((r) => activeLabels.has(getLabel(r.yieldType)));
  const warningFiltered = hideWarnings
    ? typeFiltered.filter((ranking) => ranking.warningSignals.length === 0)
    : typeFiltered;

  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    handleSortKeyDown,
    sortedRows: sorted,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<YieldRanking, YieldTableSortKey>(warningFiltered, {
    defaultKey: "pys",
    defaultDirection: "desc",
    compareRows: compareYieldRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const prefetch = usePrefetchStablecoin();
  const visibleExpandedId =
    expandedId !== null && paginated.some((row) => row.id === expandedId)
      ? expandedId
      : null;

  return (
    <TooltipProvider>
      <DataTableShell
        columns={YIELD_COLUMNS}
        sort={{
          sortKey,
          sortDirection,
          toggleSort,
          getAriaSortValue,
          handleSortKeyDown,
        }}
        topSlot={
          <div className="mb-3 flex flex-wrap items-center gap-2 px-3 pt-3">
            {visibleLabels.map((label) => {
              const repType = (Object.entries(YIELD_TYPE_LABELS) as [YieldType, string][]).find(
                ([, l]) => l === label,
              )?.[0];
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setActiveLabels((prev) => {
                      const next = new Set(prev);
                      if (next.has(label)) {
                        next.delete(label);
                      } else {
                        next.add(label);
                      }
                      return next;
                    });
                  }}
                  className={
                    activeLabels.has(label)
                      ? `pharos-focus-ring rounded-full border px-2 py-0.5 text-xs font-medium ${repType ? YIELD_TYPE_STYLES[repType].badge : ""}`
                      : "pharos-focus-ring rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  }
                >
                  {label}
                </button>
              );
            })}
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideWarnings}
                onChange={(e) => setHideWarnings(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Hide warned
            </label>
          </div>
        }
        pagination={sorted.length > 0 ? {
          page: effectivePage,
          totalPages,
          rangeStart,
          rangeEnd,
          total: totalRows,
          onPrevious: onPreviousPage,
          onNext: onNextPage,
          noun: "coins",
        } : undefined}
      >
        {paginated.map((row, index) => {
                const grade = row.safetyGrade;
                const safetyScore = row.safetyScore;
                const warningSignalCount = row.warningSignals.length;
                const pysColor = getPysColor(row.pharosYieldScore);
                const { riskPenalty, yieldEfficiency, sustainabilityMult } = computePysBreakdown(row.apy30d, safetyScore, row.yieldStability);
                return (
                  <Fragment key={row.id}>
                    <InteractiveTableRow
                      onActivate={() => setExpandedId((current) => (current === row.id ? null : row.id))}
                      onHover={() => prefetch(row.id)}
                      className={warningSignalCount >= 2 ? "border-l-2 border-amber-500/50" : ""}
                    >
                      <TableCell className="text-right text-muted-foreground text-xs font-mono tabular-nums">
                        {pageStartIndex + index + 1}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StablecoinLogo src={logos[row.id]} name={row.name} size={24} />
                          <span className="font-medium">{row.symbol}</span>
                          <span className="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline">
                            {row.name}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatPercent(row.apy30d)}</TableCell>
                      <TableCell className="hidden md:table-cell text-center">
                        {grade && grade !== "NR" ? (
                          <Badge
                            variant="outline"
                            className={`text-xs font-mono px-1 py-0 ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
                            title={safetyScore !== null ? `${grade} (${Math.round(safetyScore)}/100)` : grade}
                          >
                            {grade}
                          </Badge>
                        ) : safetyScore !== null ? (
                          <Badge
                            variant="outline"
                            className="text-xs font-mono px-1 py-0 text-muted-foreground"
                            title={`Safety score: ${Math.round(safetyScore)}/100 (grade unavailable)`}
                          >
                            {Math.round(safetyScore)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {row.pharosYieldScore !== null ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={`cursor-help ${pysColor}`}>{formatScore(row.pharosYieldScore)}</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[220px]">
                              <div className="space-y-1.5 text-xs">
                                <div>
                                  <span className="text-muted-foreground">Yield Efficiency: </span>
                                  <span className="font-mono tabular-nums">{yieldEfficiency.toFixed(1)}</span>
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  <span className="font-mono tabular-nums">{row.apy30d.toFixed(1)}%</span> APY /{" "}
                                  <span className="font-mono tabular-nums">{riskPenalty.toFixed(1)}x</span> risk
                                  penalty
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Safety: </span>
                                  <span className="font-mono tabular-nums">{grade ?? "?"}</span>
                                  <span className="text-muted-foreground">
                                    {" "}
                                    (
                                    <span className="font-mono tabular-nums">{safetyScore ?? 40}</span>
                                    )
                                  </span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Consistency: </span>
                                  <span className="font-mono tabular-nums">
                                    {(sustainabilityMult * 100).toFixed(0)}%
                                  </span>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className={`font-mono tabular-nums ${pysColor}`}>—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-left text-sm text-muted-foreground max-w-[160px]">
                        <div className="flex items-center gap-1" title={row.provenance?.selectionReason ?? row.yieldSource}>
                          <YieldSourceLink
                            href={row.yieldSourceUrl}
                            className="max-w-[160px]"
                            iconClassName="h-3 w-3"
                            stopPropagation
                          >
                            {row.yieldSource}
                          </YieldSourceLink>
                          {row.provenance?.sourceSwitch ? (
                            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                              switch
                            </span>
                          ) : null}
                          {(row.altSources?.length ?? 0) > 0 && <AltSourcesPopover altSources={row.altSources} />}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center">
                        <Badge
                          variant="outline"
                          className={`text-xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}
                        >
                          {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">
                        {row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">
                        {row.yieldStability !== null ? (
                          <div className="flex items-center justify-end gap-2">
                            <div
                              className="w-16 h-1.5 rounded-full bg-muted overflow-hidden"
                              role="progressbar"
                              aria-label={`Yield stability: ${Math.round(row.yieldStability * 100)}%`}
                              aria-valuenow={Math.round(row.yieldStability * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div
                                className="h-full rounded-full bg-emerald-500"
                                style={{ width: `${Math.min(100, Math.max(0, row.yieldStability * 100))}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono tabular-nums text-muted-foreground">
                              {Math.round(row.yieldStability * 100)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums text-xs text-muted-foreground">
                        {row.apyMin30d !== null && row.apyMax30d !== null
                          ? `${row.apyMin30d.toFixed(1)}% – ${row.apyMax30d.toFixed(1)}%`
                          : "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-center">
                        {warningSignalCount === 0 ? (
                          <span className="text-muted-foreground">&mdash;</span>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                                className="mx-auto inline-flex pharos-focus-ring"
                                aria-label={`${warningSignalCount} warning signal${warningSignalCount > 1 ? "s" : ""}`}
                              >
                                <AlertTriangle
                                  className={
                                    warningSignalCount >= 2
                                      ? "h-4 w-4 text-amber-500 fill-amber-500/20"
                                      : "h-4 w-4 text-amber-500"
                                  }
                                />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <ul className="space-y-1 text-xs">
                                {row.warningSignals.map((signal) => (
                                  <li key={signal}>{formatYieldWarningSignal(signal)}</li>
                                ))}
                              </ul>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell className="px-2 py-2 text-right">
                        <ChevronDown
                          className={
                            visibleExpandedId === row.id
                              ? "h-4 w-4 text-muted-foreground rotate-180 transition-transform"
                              : "h-4 w-4 text-muted-foreground transition-transform"
                          }
                        />
                      </TableCell>
                    </InteractiveTableRow>
                    {visibleExpandedId === row.id && (
                      <TableRow>
                        <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30 p-4">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/55 px-3 py-2.5">
                            <div className="min-w-0">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                                Yield Source
                              </p>
                              <div className="mt-1 flex min-w-0 items-center gap-2">
                                <YieldSourceLink href={row.yieldSourceUrl} className="text-sm font-medium text-foreground" stopPropagation>
                                  {row.yieldSource}
                                </YieldSourceLink>
                                {row.provenance?.sourceSwitch ? (
                                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                                    switch
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {(row.altSources?.length ?? 0) > 0 ? <AltSourcesPopover altSources={row.altSources} /> : null}
                          </div>
                          <YieldHistoryChart
                            stablecoinId={row.id}
                            riskFreeRate={riskFreeRate}
                            medianApy={medianApy}
                            compact
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground py-12">
              No yield data available.
            </TableCell>
          </TableRow>
        )}
      </DataTableShell>
    </TooltipProvider>
  );
}
