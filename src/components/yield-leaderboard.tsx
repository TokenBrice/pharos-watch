"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, DownloadIcon } from "lucide-react";
import { YieldCompareDrawer } from "@/components/yield-compare-drawer";
import { YieldCompareTray } from "@/components/yield-compare-tray";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { MobileMetricPill, MobileSortPanel, MobileSortPills } from "@/components/mobile-sort-pills";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useYieldCompareSelection } from "@/hooks/use-yield-compare-selection";
import { YieldInstrumentBoard } from "@/components/yield-instrument-board";
import { TablePagination } from "@/components/table-pagination";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableSourceLink } from "@/components/table/client";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { computePysBreakdown, formatYieldWarningSignal, getPysColor } from "@/lib/yield-constants";
import {
  formatYieldSourceRiskSummary,
  getYieldSourceDepthDisplay,
  isNativeYieldSource,
} from "@/lib/yield-source-risk";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import {
  YIELD_OPPORTUNITY_SAFETY_DESCRIPTION,
  isOpportunityDerivedSafety,
} from "@shared/lib/yield-opportunity-provenance";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { YieldCohortChip } from "@/components/yield-cohort-chip";
import { YieldWhyPysStrip } from "@/components/yield-why-pys-strip";
import { trackEvent } from "@/lib/analytics";
import {
  deriveYieldRowPresentation,
  getYieldWorkbenchSourceRole,
  isYieldBenchmarkFallback,
} from "@/lib/yield-workbench-row";
import { downloadCsvWithPreamble, type CsvColumn } from "@/lib/exports/csv";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

const SORT_KEY_LABELS: Record<YieldTableSortKey, string> = {
  pys: "PYS",
  apy30d: "APY (30d)",
  safetyScore: "Safety",
  tvl: "TVL",
  yieldStability: "Stability",
  yieldType: "Type",
  sourceCount: "Sources",
};

export interface YieldLeaderboardFilterSummary {
  visibleCount: number;
  totalCount: number;
  comparisonLabel: string;
  activeFilters: ReadonlyArray<{ key: string; label: string }>;
}

function LeaderboardHeading({
  summary,
  sortKey,
  sortDirection,
  exportRows,
  updatedAt,
  methodologyLabel,
}: {
  summary: YieldLeaderboardFilterSummary;
  sortKey: YieldTableSortKey;
  sortDirection: "asc" | "desc";
  exportRows: readonly YieldViewModelRow[];
  updatedAt: number;
  methodologyLabel: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  const sortLabel = SORT_KEY_LABELS[sortKey] ?? sortKey;
  const arrow = sortDirection === "asc" ? "↑" : "↓";
  const appended = summary.comparisonLabel ? `, ${summary.comparisonLabel} rows` : "";
  const sentence = `Showing ${summary.visibleCount} of ${summary.totalCount} rows · sorted by ${sortLabel}${arrow}${appended}`;

  const handleCopy = useCallback(async () => {
    await copy(window.location.href);
  }, [copy]);
  const handleExport = useCallback(() => {
    const exportData = exportRows.map((row, index) => ({ rank: index + 1, row }));
    downloadCsvWithPreamble(exportData, YIELD_EXPORT_COLUMNS, "pharos-yield-rankings", {
      endpoint: "yield-rankings",
      asOfISO: new Date(updatedAt * 1000).toISOString(),
      sourceUrl: window.location.href,
      methodologyLabel,
    });
    trackEvent("yield_exported", { scope: "ranking", row_count: exportData.length });
  }, [exportRows, methodologyLabel, updatedAt]);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
      <div className="space-y-1">
        <p className="pharos-kicker">Leaderboard</p>
        <h2 id="leaderboard-heading" className="pharos-section-title">
          Yield Leaderboard
        </h2>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="pharos-focus-ring inline-flex min-h-11 min-w-0 items-center rounded-md py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground sm:min-h-8 sm:py-1"
              aria-label="Filter summary; click for details"
            >
              <span className="truncate">{sentence}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[320px] border border-border bg-popover p-3 text-foreground">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Active filters
            </p>
            {summary.activeFilters.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-[11px] text-foreground">
                {summary.activeFilters.map((filter) => (
                  <li key={filter.key}>{filter.label}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">No filters applied.</p>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="pharos-focus-ring relative mt-2 inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground"
            >
              <span
                className={`pharos-copy-icon ${copied ? "text-emerald-600 dark:text-emerald-400" : ""}`}
                aria-live="polite"
              >
                {copied ? "Copied!" : "Copy URL"}
              </span>
              {copied ? <span key="copy-ring" className="pharos-copy-ring" aria-hidden="true" /> : null}
            </button>
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={handleExport}
          disabled={exportRows.length === 0}
          className="pharos-focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-8 sm:py-1"
          aria-label={`Export ${exportRows.length} yield rows as CSV`}
        >
          <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
          <span>CSV</span>
        </button>
      </div>
    </div>
  );
}

interface YieldExportRow {
  rank: number;
  row: YieldViewModelRow;
}

const YIELD_EXPORT_COLUMNS: CsvColumn<YieldExportRow>[] = [
  { header: "Rank", accessor: (entry) => entry.rank },
  { header: "ID", accessor: (entry) => entry.row.id },
  { header: "Symbol", accessor: (entry) => entry.row.symbol },
  { header: "Name", accessor: (entry) => entry.row.name },
  { header: "APY 30d (%)", accessor: (entry) => entry.row.apy30d },
  { header: "PYS", accessor: (entry) => entry.row.pharosYieldScore ?? "NR" },
  { header: "PYS qualification", accessor: (entry) => entry.row.provenance?.scoreQualification ?? "unknown" },
  { header: "PYS null reason", accessor: (entry) => entry.row.pysNullReason ?? "" },
  { header: "Safety grade", accessor: (entry) => entry.row.safetyGrade ?? "NR" },
  { header: "Safety score", accessor: (entry) => entry.row.safetyScore ?? "NR" },
  {
    header: "Safety provenance",
    accessor: (entry) =>
      isOpportunityDerivedSafety(entry.row.provenance?.safetyProvenance)
        ? "opportunity-derived"
        : "safety-score-v9",
  },
  { header: "Yield source", accessor: (entry) => entry.row.yieldSource },
  { header: "Yield type", accessor: (entry) => entry.row.yieldType },
  { header: "Source posture", accessor: (entry) => entry.row.sourcePosture ?? "unknown" },
  { header: "Source confidence", accessor: (entry) => entry.row.provenance?.confidenceTier ?? "unknown" },
  { header: "Evidence completeness", accessor: (entry) => entry.row.provenance?.evidenceCompleteness ?? "unknown" },
  { header: "Benchmark", accessor: (entry) => entry.row.benchmarkLabel ?? "unknown" },
  { header: "TVL USD", accessor: (entry) => entry.row.sourceTvlUsd ?? "unknown" },
  { header: "Stability", accessor: (entry) => entry.row.yieldStability ?? "unknown" },
  { header: "Warnings", accessor: (entry) => entry.row.warningSignals.join(" | ") },
  { header: "Provider URL", accessor: (entry) => entry.row.yieldSourceUrl ?? "" },
];

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
  scalingFactor: number;
  emptyMessage?: string;
  filterSummary?: YieldLeaderboardFilterSummary;
  comparisonRows?: readonly YieldViewModelRow[];
  updatedAt?: number;
  methodologyLabel?: string;
}

export function YieldLeaderboard({
  rows,
  logos,
  riskFreeRate,
  medianApy,
  scalingFactor,
  emptyMessage,
  filterSummary,
  comparisonRows = rows,
  updatedAt = Math.floor(Date.now() / 1000),
  methodologyLabel = "Pharos Yield Score current",
}: YieldLeaderboardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const [compareDrawerOpen, setCompareDrawerOpen] = useState(false);
  const compare = useYieldCompareSelection();
  const initialCompareDeepLink = useRef(compare.ids.length >= 2);
  const initialCompareProcessed = useRef(false);
  const rowsById = useMemo(() => new Map(comparisonRows.map((row) => [row.id, row] as const)), [comparisonRows]);
  const detailedRankings = useYieldRankings({ enabled: sheetRankingId !== null });
  const sheetRanking = useMemo(
    () => (sheetRankingId ? (detailedRankings.data?.rankings.find((row) => row.id === sheetRankingId) ?? null) : null),
    [detailedRankings.data?.rankings, sheetRankingId],
  );

  const {
    sortKey,
    sortDirection,
    toggleSort,
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
  const handleToggleExpanded = useCallback(
    (stablecoinId: string) => {
      if (expandedId !== stablecoinId) {
        const row = rowsById.get(stablecoinId);
        trackEvent("yield_row_action", {
          action: "history_opened",
          coin_id: stablecoinId,
          warning_count: row?.warningSignals.length ?? 0,
        });
      }
      setExpandedId((current) => (current === stablecoinId ? null : stablecoinId));
    },
    [expandedId, rowsById],
  );
  const handleOpenSourceSheet = useCallback(
    (stablecoinId: string) => {
      const row = rowsById.get(stablecoinId);
      trackEvent("yield_row_action", {
        action: "source_opened",
        coin_id: stablecoinId,
        warning_count: row?.warningSignals.length ?? 0,
      });
      setSheetRankingId(stablecoinId);
    },
    [rowsById],
  );
  const handleToggleSort = useCallback(
    (key: YieldTableSortKey) => {
      const direction = sortKey === key && sortDirection === "desc" ? "asc" : "desc";
      trackEvent("yield_sort_changed", { sort_by: key, direction });
      toggleSort(key);
    },
    [sortDirection, sortKey, toggleSort],
  );
  const handleOpenCompare = useCallback(() => {
    setCompareDrawerOpen(true);
    trackEvent("yield_compare_opened", { source: "tray", coin_count: compare.ids.length });
  }, [compare.ids.length]);

  useEffect(() => {
    if (initialCompareProcessed.current) return;
    initialCompareProcessed.current = true;
    if (!initialCompareDeepLink.current) return;
    setCompareDrawerOpen(true);
    trackEvent("yield_compare_opened", { source: "deep_link", coin_count: compare.ids.length });
  }, [compare.ids.length]);

  return (
    <TooltipProvider>
      {filterSummary ? (
        <LeaderboardHeading
          summary={filterSummary}
          sortKey={sortKey}
          sortDirection={sortDirection}
          exportRows={sorted}
          updatedAt={updatedAt}
          methodologyLabel={methodologyLabel}
        />
      ) : null}
      <div className="space-y-3 md:hidden">
        <MobileSortPanel kicker="Sort Leaderboard">
          <MobileSortPills
            options={MOBILE_SORT_OPTIONS}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleToggleSort}
            ariaLabel="Sort yield leaderboard"
          />
        </MobileSortPanel>

        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyMessage ?? "No yield data available."}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {paginated.map((row) => {
                const isCompared = compare.has(row.id);
                const compareDisabled = !isCompared && !compare.canAdd;
                return (
                  <YieldMobileCard
                    key={row.id}
                    row={row}
                    logo={logos[row.id]}
                    riskFreeRate={riskFreeRate}
                    medianApy={medianApy}
                    expanded={visibleExpandedId === row.id}
                    isCompared={isCompared}
                    compareDisabled={compareDisabled}
                    onToggleExpanded={handleToggleExpanded}
                    onOpenSourceSheet={handleOpenSourceSheet}
                    onToggleCompare={compare.toggle}
                  />
                );
              })}
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
              className="pharos-table-shell"
              bordered={false}
            />
          </>
        )}
      </div>

      <div className="hidden md:block">
        <YieldInstrumentBoard
          rows={paginated}
          logos={logos}
          riskFreeRate={riskFreeRate}
          medianApy={medianApy}
          scalingFactor={scalingFactor}
          pageStartIndex={pageStartIndex}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onToggleSort={handleToggleSort}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={totalRows}
          pagination={
            sorted.length > 0
              ? {
                  page: effectivePage,
                  totalPages,
                  rangeStart,
                  rangeEnd,
                  total: totalRows,
                  onPrevious: onPreviousPage,
                  onNext: onNextPage,
                  noun: "coins",
                }
              : undefined
          }
          expandedId={visibleExpandedId}
          compareHas={compare.has}
          compareCanAdd={compare.canAdd}
          onPrefetch={prefetch}
          onToggleExpanded={handleToggleExpanded}
          onOpenSourceSheet={handleOpenSourceSheet}
          onToggleCompare={compare.toggle}
          emptyMessage={emptyMessage}
        />
      </div>
      <YieldSourceSheet
        ranking={sheetRanking}
        logo={sheetRankingId ? logos[sheetRankingId] : undefined}
        riskFreeRate={riskFreeRate}
        medianApy={medianApy}
        open={sheetRankingId !== null}
        onOpenChange={(open) => {
          if (!open) setSheetRankingId(null);
        }}
      />
      <YieldCompareTray rows={comparisonRows} logos={logos} onOpenDrawer={handleOpenCompare} />
      {compare.ids.length > 0 ? <div className="h-20 sm:hidden" aria-hidden="true" /> : null}
      <YieldCompareDrawer
        open={compareDrawerOpen}
        onOpenChange={setCompareDrawerOpen}
        rows={comparisonRows}
        logos={logos}
        updatedAt={updatedAt}
        methodologyLabel={methodologyLabel}
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
  isCompared,
  compareDisabled,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
}: {
  row: YieldViewModelRow;
  logo?: string;
  riskFreeRate: number;
  medianApy: number;
  expanded: boolean;
  isCompared: boolean;
  compareDisabled: boolean;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
  onToggleCompare: (stablecoinId: string) => void;
}) {
  const pysColor = getPysColor(row.pharosYieldScore);
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  const stabilityPct = row.yieldStability !== null ? Math.round(row.yieldStability * 100) : null;
  const sourceRole = getYieldWorkbenchSourceRole(row);
  // Native rows have no venue to size apart from the asset itself: a null TVL
  // there is "not applicable", not a measurement we missed.
  const tvlIsNative = row.sourceTvlUsd === null && isNativeYieldSource(sourceRole, row.yieldType);
  const tvlLabel =
    row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : tvlIsNative ? "Native" : "—";
  const depthDisplay = getYieldSourceDepthDisplay({
    depthLens: row.sourceDepthLens,
    yieldType: row.yieldType,
    sourceRole,
    sourceTvlUsd: row.sourceTvlUsd,
  });
  const warningCount = row.warningSignals.length;
  const sourceRiskSummary = formatYieldSourceRiskSummary(row.sourceRisk);
  const {
    confidenceStyle,
    confidenceLabel,
    freshness,
    sourceRiskScore,
    rawSourceRiskPenalty,
    sourceRiskMaterial,
    sourceRiskDrivers,
    rankChip,
    pysNullReasonText,
    availableSources,
    altSourceCount,
    benchmarkReferenceText,
  } = deriveYieldRowPresentation(row);

  // WHY: only used when expanded with a non-null PYS; cheap to compute inline rather than extracting a helper.
  const { adjustedRiskPenalty, benchmarkSpread, sourceRiskPenalty, sustainabilityMult } = computePysBreakdown(
    row.apy30d,
    safetyScore,
    row.yieldStability,
    row.benchmarkRate,
    row.sourceRisk?.sourceRiskPenalty ?? null,
  );

  return (
    <article
      className={`pharos-card-shell rounded-xl p-4 ${warningCount >= 2 ? "border-l-2 border-l-amber-500/60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={buildStablecoinUrl(row.id)}
            className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-md"
          >
            <StablecoinLogo src={logo} name={row.name} size={30} />
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="font-semibold text-foreground">{row.symbol}</span>
                <span className="truncate text-xs text-muted-foreground">{row.name}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{row.yieldSource}</span>
            </span>
          </Link>
          <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} className="h-11 w-11 min-w-11" />
          <button
            type="button"
            aria-pressed={isCompared}
            disabled={compareDisabled}
            onClick={() => onToggleCompare(row.id)}
            aria-label={`Add ${row.symbol} to compare`}
            className="pharos-focus-ring inline-flex h-11 w-11 min-w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className={`h-4 w-4 rounded border ${
                isCompared
                  ? "border-foreground bg-foreground ring-2 ring-inset ring-background"
                  : "border-border/70 bg-background/60"
              }`}
            />
          </button>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg font-semibold leading-none tabular-nums text-foreground">
            {formatPercent(row.apy30d)}
          </p>
          <p className={`mt-1 inline-flex items-center justify-end gap-1 font-mono text-xs tabular-nums ${pysColor}`}>
            {row.pharosYieldScore !== null ? (
              <>
                <span>PYS {formatScore(row.pharosYieldScore)}</span>
                {rankChip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`inline-flex cursor-help items-center gap-0.5 rounded-full border border-border/40 bg-background/60 px-1.5 py-0 text-[10px] font-medium ${rankChip.colorClass}`}
                        aria-label={`Rank change: ${rankChip.signedRank}, driver ${rankChip.short}`}
                      >
                        <span aria-hidden="true">{rankChip.arrow}</span>
                        <span className="font-mono tabular-nums">{rankChip.signedRank}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[240px] text-[11px]">
                      <span className="block">{rankChip.long}</span>
                      {rankChip.pysDeltaLabel ? (
                        <span className="block font-mono tabular-nums text-muted-foreground">
                          {rankChip.pysDeltaLabel}
                        </span>
                      ) : null}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <YieldCohortChip cohort={row.cohortPercentile} />
              </>
            ) : pysNullReasonText ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">PYS —</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[220px] text-[11px]">{pysNullReasonText}</TooltipContent>
              </Tooltip>
            ) : (
              <span>PYS —</span>
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {confidenceStyle && confidenceLabel ? <span className={confidenceStyle.pill}>{confidenceLabel}</span> : null}
        {grade && grade !== "NR" ? (
          <Badge
            variant="outline"
            className={`px-1.5 py-0.5 text-[10px] font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
            title={
              isOpportunityDerivedSafety(row.provenance?.safetyProvenance)
                ? YIELD_OPPORTUNITY_SAFETY_DESCRIPTION
                : undefined
            }
          >
            {grade}
            {isOpportunityDerivedSafety(row.provenance?.safetyProvenance) ? (
              <span aria-hidden="true" className="ml-0.5 align-super text-[8px] leading-none">
                {"\u2020"}
              </span>
            ) : null}
          </Badge>
        ) : null}
        <Badge variant="outline" className={`text-[10px] ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
          {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
        </Badge>
        <MobileMetricPill>
          TVL{" "}
          <span className={tvlIsNative ? "text-muted-foreground" : "font-mono tabular-nums text-foreground"}>
            {tvlLabel}
          </span>
        </MobileMetricPill>
        {stabilityPct !== null ? (
          <MobileMetricPill>
            Stability <span className="font-mono tabular-nums text-foreground">{stabilityPct}%</span>
          </MobileMetricPill>
        ) : null}
        {freshness ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <MobileMetricPill className={`cursor-help ${freshness.textClassName}`}>
                {freshness.displayText}
              </MobileMetricPill>
            </TooltipTrigger>
            <TooltipContent className="text-[11px]">
              {freshness.tooltipText}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {warningCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle
                  className={
                    warningCount >= 2 ? "h-3.5 w-3.5 fill-amber-500/20 text-amber-500" : "h-3.5 w-3.5 text-amber-500"
                  }
                  aria-hidden="true"
                />
                <span>{`${warningCount} warning${warningCount === 1 ? "" : "s"}`}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[11px]">
              {sourceRiskMaterial
                ? `${warningCount} warning signal${warningCount === 1 ? "" : "s"} + source-risk ${(rawSourceRiskPenalty ?? 0).toFixed(2)}×`
                : `${warningCount} warning signal${warningCount === 1 ? "" : "s"}`}
            </TooltipContent>
          </Tooltip>
        ) : sourceRiskMaterial ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1 text-amber-700/80 dark:text-amber-400/80">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500/70" aria-hidden="true" />
                <span>Source-risk</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[11px]">
              Source-risk penalty {(rawSourceRiskPenalty ?? 0).toFixed(2)}× (no warning signals)
            </TooltipContent>
          </Tooltip>
        ) : (
          <span>No warnings</span>
        )}
      </div>

      <div className="mt-3 rounded-xl border border-border/60 bg-background/45 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <p>{benchmarkReferenceText}</p>
          <YieldSourceRiskBar score={sourceRiskScore} compact tooltip />
        </div>
        <p className="mt-1" title={depthDisplay.description}>
          {depthDisplay.isNativeUnmeasured ? depthDisplay.phrase : `Depth: ${depthDisplay.label}`}
        </p>
        {sourceRiskSummary ? (
          <p className="mt-1 font-mono text-[11px] tabular-nums text-amber-700 dark:text-amber-300">
            {sourceRiskSummary}
          </p>
        ) : null}
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
        <TableSourceLink
          href={row.yieldSourceUrl}
          onClick={() => {
            trackEvent("yield_row_action", {
              action: "provider_opened",
              coin_id: row.id,
              warning_count: warningCount,
            });
          }}
          className="min-h-11 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium"
          iconClassName="h-3.5 w-3.5"
        >
          Provider
        </TableSourceLink>
        <Link
          href={buildStablecoinUrl(row.id, "yield/")}
          prefetch={false}
          onClick={() => {
            trackEvent("yield_row_action", {
              action: "deep_dive_opened",
              coin_id: row.id,
              warning_count: warningCount,
            });
          }}
          aria-label={`Open full yield analysis for ${row.symbol}`}
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-foreground hover:bg-accent"
        >
          <span>Deep dive</span>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {expanded ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-background/55 px-3 py-3">
          {row.pharosYieldScore !== null ? (
            <YieldWhyPysStrip
              benchmarkSpread={benchmarkSpread}
              benchmarkLabel={row.benchmarkLabel}
              stabilityPct={stabilityPct}
              sustainabilityMult={sustainabilityMult}
              grade={grade}
              safetyScore={safetyScore}
              adjustedRiskPenalty={adjustedRiskPenalty}
              sourceRiskPenalty={sourceRiskPenalty}
              sourceRiskDriverLabel={sourceRiskDrivers[0]?.label ?? null}
            />
          ) : null}
          <YieldHistoryChart
            stablecoinId={row.id}
            benchmarkRate={row.benchmarkRate ?? riskFreeRate}
            benchmarkLabel={row.benchmarkLabel}
            benchmarkIsFallback={isYieldBenchmarkFallback(row)}
            medianApy={medianApy}
            compact
            availableSources={availableSources}
          />
        </div>
      ) : null}
    </article>
  );
}
