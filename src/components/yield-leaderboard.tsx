"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { YieldCompareDrawer } from "@/components/yield-compare-drawer";
import { YieldCompareTray } from "@/components/yield-compare-tray";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { MobileSortPills } from "@/components/mobile-sort-pills";
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
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { buildStablecoinUrl } from "@/lib/urls";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import {
  computePysBreakdown,
  formatYieldWarningSignal,
  getPysColor,
} from "@/lib/yield-constants";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceFreshness,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { YieldCohortChip } from "@/components/yield-cohort-chip";
import { YieldWhyPysStrip } from "@/components/yield-why-pys-strip";
import { PYS_NULL_REASON_TEXT, buildRankChangeChipDisplay } from "@/lib/yield-presentation";
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
}: {
  summary: YieldLeaderboardFilterSummary;
  sortKey: YieldTableSortKey;
  sortDirection: "asc" | "desc";
}) {
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const sortLabel = SORT_KEY_LABELS[sortKey] ?? sortKey;
  const arrow = sortDirection === "asc" ? "↑" : "↓";
  const appended = summary.comparisonLabel ? `, ${summary.comparisonLabel} rows` : "";
  const sentence = `Showing ${summary.visibleCount} of ${summary.totalCount} rows · sorted by ${sortLabel}${arrow}${appended}`;

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const handleCopy = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // WHY: clipboard API can throw in non-secure contexts; degrade silently.
    }
  }, []);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
      <h2 id="leaderboard-heading" className="text-xl font-semibold">
        Yield Leaderboard
      </h2>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="pharos-focus-ring inline-flex min-h-11 max-w-full items-center rounded-md py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground sm:min-h-8 sm:py-1"
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
            className="pharos-focus-ring relative mt-2 inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] font-medium text-frost-blue underline-offset-2 hover:underline"
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
    </div>
  );
}

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
  filterSummary?: YieldLeaderboardFilterSummary;
}

export function YieldLeaderboard({ rows, logos, riskFreeRate, medianApy, emptyMessage, filterSummary }: YieldLeaderboardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const [compareDrawerOpen, setCompareDrawerOpen] = useState(false);
  const compare = useYieldCompareSelection();
  const sheetRanking = useMemo(
    () => (sheetRankingId ? rows.find((r) => r.id === sheetRankingId) ?? null : null),
    [rows, sheetRankingId],
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
  const handleToggleExpanded = useCallback((stablecoinId: string) => {
    setExpandedId((current) => (current === stablecoinId ? null : stablecoinId));
  }, []);

  return (
    <TooltipProvider>
      {filterSummary ? (
        <LeaderboardHeading
          summary={filterSummary}
          sortKey={sortKey}
          sortDirection={sortDirection}
        />
      ) : null}
      <div className="space-y-3 md:hidden">
        <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
          <p className="pharos-kicker mb-2">Sort Leaderboard</p>
          <MobileSortPills
            options={MOBILE_SORT_OPTIONS}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={toggleSort}
            ariaLabel="Sort yield leaderboard"
          />
        </div>

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
                    onOpenSourceSheet={setSheetRankingId}
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
              className="rounded-xl border border-border/70 bg-card/80"
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
          pageStartIndex={pageStartIndex}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onToggleSort={toggleSort}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={totalRows}
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
          expandedId={visibleExpandedId}
          compareHas={compare.has}
          compareCanAdd={compare.canAdd}
          onPrefetch={prefetch}
          onToggleExpanded={handleToggleExpanded}
          onOpenSourceSheet={setSheetRankingId}
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
        onOpenChange={(open) => { if (!open) setSheetRankingId(null); }}
      />
      <YieldCompareTray rows={rows} logos={logos} onOpenDrawer={() => setCompareDrawerOpen(true)} />
      <YieldCompareDrawer
        open={compareDrawerOpen}
        onOpenChange={setCompareDrawerOpen}
        rows={rows}
        logos={logos}
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
  const confidenceTier = row.provenance?.confidenceTier ?? null;
  const confidenceStyle = confidenceTier ? YIELD_SOURCE_CONFIDENCE_STYLES[confidenceTier] : null;
  const confidenceLabel = confidenceTier ? YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier].label : null;
  const freshness = classifyYieldSourceFreshness(row.sourceRisk?.sourceAgeSeconds ?? null);
  const sourceRiskScore = row.sourceRisk?.sourceRiskScore ?? null;
  const rawSourceRiskPenalty = row.sourceRisk?.sourceRiskPenalty ?? null;
  const sourceRiskMaterial = rawSourceRiskPenalty !== null && rawSourceRiskPenalty > 1.05;
  const pysNullReasonText =
    row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null;
  const rankChip = buildRankChangeChipDisplay(row.rankChangeAttribution);

  // WHY: only used when expanded with a non-null PYS; cheap to compute inline rather than extracting a helper.
  const { adjustedRiskPenalty, benchmarkSpread, sourceRiskPenalty, sustainabilityMult } = computePysBreakdown(
    row.apy30d,
    safetyScore,
    row.yieldStability,
    row.benchmarkRate,
    row.sourceRisk?.sourceRiskPenalty ?? null,
  );
  const sourceRiskDrivers = getYieldSourceRiskDrivers({
    sourceRisk: row.sourceRisk,
    sourceChanged: row.provenance?.sourceSwitch ?? false,
  });

  return (
    <article className={`pharos-card-shell rounded-xl p-4 ${warningCount >= 2 ? "border-l-2 border-l-amber-500/60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={buildStablecoinUrl(row.id)} className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-md">
            <StablecoinLogo src={logo} name={row.name} size={30} />
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="font-semibold text-foreground">{row.symbol}</span>
                <span className="truncate text-xs text-muted-foreground">{row.name}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {row.yieldSource}
              </span>
            </span>
          </Link>
          <YieldWatchlistStar
            stablecoinId={row.id}
            symbol={row.symbol}
            className="h-11 w-11 min-w-11"
          />
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
                  ? "border-frost-blue bg-frost-blue ring-2 ring-inset ring-background"
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
                        <span className="block font-mono tabular-nums text-muted-foreground">{rankChip.pysDeltaLabel}</span>
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
        {confidenceStyle && confidenceLabel ? (
          <span className={confidenceStyle.pill}>{confidenceLabel}</span>
        ) : null}
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
        {freshness ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`cursor-help rounded-full border border-border/60 bg-background/55 px-2 py-1 ${freshness.textClassName}`}>
                Updated {freshness.relativeText}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-[11px]">
              Source observed {freshness.relativeText} ({freshness.tier})
            </TooltipContent>
          </Tooltip>
        ) : null}
        {warningCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle
                  className={
                    warningCount >= 2
                      ? "h-3.5 w-3.5 fill-amber-500/20 text-amber-500"
                      : "h-3.5 w-3.5 text-amber-500"
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
        <TableSourceLink
          href={row.yieldSourceUrl}
          className="min-h-11 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium"
          iconClassName="h-3.5 w-3.5"
        >
          Provider
        </TableSourceLink>
        <Link
          href={`${buildStablecoinUrl(row.id)}yield/`}
          prefetch={false}
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
