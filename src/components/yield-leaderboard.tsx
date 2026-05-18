"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import {
  DataTableEmptyRow,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TablePagination } from "@/components/table-pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldSourceLink } from "@/components/yield-source-link";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { YieldLeaderboardTableRow } from "@/components/yield-leaderboard-table-row";
import { buildStablecoinUrl } from "@/lib/urls";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import {
  formatYieldWarningSignal,
  getPysColor,
} from "@/lib/yield-constants";
import { YIELD_SOURCE_DEPTH_DEFINITIONS } from "@/lib/yield-source-risk";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

const YIELD_COLUMNS: readonly DataTableColumn<YieldTableSortKey>[] = [
  { id: "coin", label: "Coin", className: "hidden md:table-cell w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "apy30d", label: "APY (30d)", sortKey: "apy30d", className: "hidden md:table-cell text-right", title: "30-day average annual percentage yield" },
  { id: "safety", label: "Safety", sortKey: "safetyScore", className: "hidden md:table-cell text-center", title: "Pharos Safety Grade / Score" },
  {
    id: "pys",
    label: "PYS",
    headerAdornment: <MethodologyHint topic="pys" />,
    sortKey: "pys",
    className: "hidden md:table-cell text-right",
    title: "Pharos Yield Score: risk-adjusted yield ranking",
  },
  { id: "source", label: "Source", className: "hidden md:table-cell text-left" },
  { id: "yieldType", label: "Type", sortKey: "yieldType", className: "hidden md:table-cell text-center", title: "Yield mechanism type" },
  { id: "tvl", label: "TVL", sortKey: "tvl", className: "hidden lg:table-cell text-right", title: "Total value locked in yield source" },
  {
    id: "yieldStability",
    label: "Stability",
    headerAdornment: <MethodologyHint topic="yieldStability" />,
    sortKey: "yieldStability",
    className: "hidden lg:table-cell text-right",
    title: "Yield stability over 30 days (0-100%)",
  },
  { id: "range30d", label: "30d Range", className: "hidden xl:table-cell text-right" },
  { id: "signals", label: <MethodologyLabel topic="yieldWarnings">Signals</MethodologyLabel>, className: "hidden md:table-cell text-center" },
  { id: "expand", label: <span className="sr-only">Expand row</span>, className: "hidden md:table-cell w-[44px] text-right" },
] as const;

const COLUMN_COUNT = YIELD_COLUMNS.length;

const MOBILE_SORT_OPTIONS: Array<{ key: YieldTableSortKey; label: string }> = [
  { key: "pys", label: "PYS" },
  { key: "apy30d", label: "APY" },
  { key: "safetyScore", label: "Safety" },
  { key: "tvl", label: "TVL" },
  { key: "yieldStability", label: "Stability" },
];

interface YieldLeaderboardProps {
  rows: YieldViewModelRow[];
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
  emptyMessage?: string;
}

export function YieldLeaderboard({ rows, logos, riskFreeRate, medianApy, emptyMessage }: YieldLeaderboardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const sheetRanking = useMemo(
    () => (sheetRankingId ? rows.find((r) => r.id === sheetRankingId) ?? null : null),
    [rows, sheetRankingId],
  );

  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    sortedRows: sorted,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<YieldViewModelRow, YieldTableSortKey>(rows, {
    defaultKey: "pys",
    defaultDirection: "desc",
    compareRows: compareYieldRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const prefetch = usePrefetchStablecoin();
  const visibleExpandedId = useMemo(
    () => (expandedId !== null && paginated.some((row) => row.id === expandedId) ? expandedId : null),
    [expandedId, paginated],
  );
  const handleToggleExpanded = useCallback((stablecoinId: string) => {
    setExpandedId((current) => (current === stablecoinId ? null : stablecoinId));
  }, []);

  return (
    <TooltipProvider>
      <div className="space-y-3 md:hidden">
        <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
          <p className="pharos-kicker mb-2">Sort Leaderboard</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Sort yield leaderboard">
            {MOBILE_SORT_OPTIONS.map((option) => {
              const active = sortKey === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleSort(option.key)}
                  className={`pharos-focus-ring inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
                    active
                      ? "border-frost-blue/50 bg-frost-blue/12 text-foreground"
                      : "border-border/60 bg-background/60 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                  {active ? (
                    <span className="ml-1 font-mono text-[10px]" aria-hidden="true">
                      {sortDirection === "asc" ? "↑" : "↓"}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyMessage ?? "No yield data available."}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {paginated.map((row) => (
                <YieldMobileCard
                  key={row.id}
                  row={row}
                  logo={logos[row.id]}
                  riskFreeRate={riskFreeRate}
                  medianApy={medianApy}
                  expanded={visibleExpandedId === row.id}
                  onToggleExpanded={handleToggleExpanded}
                  onOpenSourceSheet={setSheetRankingId}
                />
              ))}
            </div>
            <TablePagination
              page={effectivePage}
              totalPages={totalPages}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              total={totalRows}
              onPrevious={onPreviousPage}
              onNext={onNextPage}
              noun="coins"
              className="rounded-xl border border-border/70 bg-card/80"
              bordered={false}
            />
          </>
        )}
      </div>

      <div className="hidden md:block">
        <DataTableShell
          columns={YIELD_COLUMNS}
          striped
          containerClassName="-mx-4 max-w-[calc(100%+2rem)] px-4 sm:mx-0 sm:max-w-none sm:px-0"
          sort={{
            sortKey,
            sortDirection,
            toggleSort,
            getAriaSortValue,
          }}
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
          {paginated.map((row) => (
            <YieldLeaderboardTableRow
              key={row.id}
              row={row}
              logos={logos}
              riskFreeRate={riskFreeRate}
              medianApy={medianApy}
              columnCount={COLUMN_COUNT}
              expanded={visibleExpandedId === row.id}
              onPrefetch={prefetch}
              onToggleExpanded={handleToggleExpanded}
              onOpenSourceSheet={setSheetRankingId}
            />
          ))}
          {sorted.length === 0 && (
            <DataTableEmptyRow colSpan={COLUMN_COUNT}>
              {emptyMessage ?? "No yield data available."}
            </DataTableEmptyRow>
          )}
        </DataTableShell>
      </div>
      <YieldSourceSheet
        ranking={sheetRanking}
        logo={sheetRankingId ? logos[sheetRankingId] : undefined}
        riskFreeRate={riskFreeRate}
        medianApy={medianApy}
        open={sheetRankingId !== null}
        onOpenChange={(open) => { if (!open) setSheetRankingId(null); }}
      />
    </TooltipProvider>
  );
}

export function YieldMobileCard({
  row,
  logo,
  riskFreeRate,
  medianApy,
  expanded,
  onToggleExpanded,
  onOpenSourceSheet,
}: {
  row: YieldViewModelRow;
  logo?: string;
  riskFreeRate: number;
  medianApy: number;
  expanded: boolean;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
}) {
  const pysColor = getPysColor(row.pharosYieldScore);
  const grade = row.safetyGrade;
  const stabilityPct = row.yieldStability !== null ? Math.round(row.yieldStability * 100) : null;
  const tvlLabel = row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—";
  const warningCount = row.warningSignals.length;
  const benchmarkReferenceText = getYieldBenchmarkReferenceText(row);
  const altSourceCount = row.altSources?.length ?? 0;
  const availableSources = [
    ...(row.provenance?.sourceKey
      ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }]
      : []),
    ...(row.altSources ?? []).map((source) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    })),
  ];

  return (
    <article className={`pharos-card-shell rounded-xl p-4 ${warningCount >= 2 ? "border-l-2 border-l-amber-500/60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={buildStablecoinUrl(row.id)} className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-md">
          <StablecoinLogo src={logo} name={row.name} size={30} />
          <span className="min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="font-semibold text-foreground">{row.symbol}</span>
              <span className="truncate text-xs text-muted-foreground">{row.name}</span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {row.provenance?.confidenceTier ?? "source"} · {row.yieldSource}
            </span>
          </span>
        </Link>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg font-semibold leading-none tabular-nums text-foreground">
            {formatPercent(row.apy30d)}
          </p>
          <p className={`mt-1 font-mono text-xs tabular-nums ${pysColor}`}>
            PYS {row.pharosYieldScore !== null ? formatScore(row.pharosYieldScore) : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {grade && grade !== "NR" ? (
          <Badge variant="outline" className={`px-1.5 py-0.5 text-[10px] font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}>
            {grade}
          </Badge>
        ) : null}
        <Badge variant="outline" className={`text-[10px] ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
          {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
        </Badge>
        <span className="rounded-full border border-border/60 bg-background/55 px-2 py-1">
          TVL <span className="font-mono tabular-nums text-foreground">{tvlLabel}</span>
        </span>
        {stabilityPct !== null ? (
          <span className="rounded-full border border-border/60 bg-background/55 px-2 py-1">
            Stability <span className="font-mono tabular-nums text-foreground">{stabilityPct}%</span>
          </span>
        ) : null}
        <span className={warningCount > 0 ? "text-amber-700 dark:text-amber-400" : ""}>
          {warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : "No warnings"}
        </span>
      </div>

      <div className="mt-3 rounded-xl border border-border/60 bg-background/45 px-3 py-2 text-xs text-muted-foreground">
        <p>{benchmarkReferenceText}</p>
        <p className="mt-1" title={YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].description}>
          Depth: {YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].label}
        </p>
      </div>

      {warningCount > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-amber-700 dark:text-amber-300">
          {row.warningSignals.slice(0, 2).map((signal) => (
            <li key={signal}>{formatYieldWarningSignal(signal)}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onToggleExpanded(row.id)}
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-foreground hover:bg-accent"
          aria-expanded={expanded}
        >
          {expanded ? "Hide history" : "Show history"}
        </button>
        <button
          type="button"
          onClick={() => onOpenSourceSheet(row.id)}
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-foreground hover:bg-accent"
        >
          {altSourceCount > 0 ? `${1 + altSourceCount} sources` : "Source"}
        </button>
        <YieldSourceLink
          href={row.yieldSourceUrl}
          className="min-h-11 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium"
          iconClassName="h-3.5 w-3.5"
        >
          Provider
        </YieldSourceLink>
      </div>

      {expanded ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-background/55 px-3 py-3">
          <YieldHistoryChart
            stablecoinId={row.id}
            benchmarkRate={row.benchmarkRate ?? riskFreeRate}
            benchmarkLabel={row.benchmarkLabel}
            benchmarkIsFallback={row.benchmarkSelectionMode === "fallback-usd" || row.benchmarkIsFallback}
            medianApy={medianApy}
            compact
            availableSources={availableSources}
          />
        </div>
      ) : null}
    </article>
  );
}
