"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import {
  DataTableEmptyRow,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TablePagination } from "@/components/table-pagination";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldSourceLink } from "@/components/yield-source-link";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { YieldLeaderboardTableRow } from "@/components/yield-leaderboard-table-row";
import { buildStablecoinUrl } from "@/lib/urls";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import {
  computePysBreakdown,
  formatYieldWarningSignal,
  getPysColor,
} from "@/lib/yield-constants";
import {
  YIELD_RANK_CHANGE_DRIVER_LABELS,
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceFreshness,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore, formatSignedPercent } from "@shared/lib/format";
import { PYS_SUSTAINABILITY_FLOOR } from "@shared/lib/yield-scoring";
import type { YieldPysNullReason } from "@shared/types";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

const PYS_NULL_REASON_TEXT: Record<YieldPysNullReason, string> = {
  "apy-non-positive": "30d APY ≤ 0",
  "effective-yield-non-positive": "Effective yield ≤ 0 after benchmark",
  "scaling-invalid": "Scaling factor unavailable",
  "missing-inputs": "Missing inputs",
};

function formatSignedPysDelta(delta: number): string {
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(1) : delta.toFixed(2);
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "+";
  return `${sign}${rounded} PYS`;
}

// WHY: ω3 owns the canonical type on YieldViewModelRow; mirror the shape locally so this
// component compiles regardless of merge order.
interface CohortPercentile {
  value: number | null;
  cohortSize: number;
  cohortKey: string;
}

function readCohortPercentile(row: YieldViewModelRow): CohortPercentile | null {
  return (row as { cohortPercentile?: CohortPercentile }).cohortPercentile ?? null;
}

function renderCohortChip(cohort: CohortPercentile | null) {
  if (cohort === null) return null;
  if (cohort.value === null) {
    return (
      <span
        title="Cohort smaller than 8 peers"
        className="text-[10px] text-muted-foreground tabular-nums"
      >
        small peer set
      </span>
    );
  }
  return (
    <span
      title={`Percentile ${cohort.value} in ${cohort.cohortSize} peers`}
      className="text-[10px] text-muted-foreground tabular-nums"
    >
      p{cohort.value} of {cohort.cohortSize}
    </span>
  );
}

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
  const sortLabel = SORT_KEY_LABELS[sortKey] ?? sortKey;
  const arrow = sortDirection === "asc" ? "↑" : "↓";
  const appended = summary.comparisonLabel ? `, ${summary.comparisonLabel} rows` : "";
  const sentence = `Showing ${summary.visibleCount} of ${summary.totalCount} rows · sorted by ${sortLabel}${arrow}${appended}`;

  const handleCopy = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
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
            className="pharos-focus-ring inline-flex max-w-full items-center rounded-md text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
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
            className="pharos-focus-ring mt-2 inline-flex items-center text-[11px] font-medium text-frost-blue underline-offset-2 hover:underline"
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

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
  filterSummary?: YieldLeaderboardFilterSummary;
}

export function YieldLeaderboard({ rows, logos, riskFreeRate, medianApy, emptyMessage, filterSummary }: YieldLeaderboardProps) {
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

interface WhyPysStripMobileProps {
  benchmarkSpread: number | null;
  benchmarkLabel?: string | null;
  stabilityPct: number | null;
  sustainabilityMult: number;
  grade: string | null;
  safetyScore: number | null;
  adjustedRiskPenalty: number;
  sourceRiskPenalty: number;
  sourceRiskDriverLabel: string | null;
}

function WhyPysStripMobile({
  benchmarkSpread,
  benchmarkLabel,
  stabilityPct,
  sustainabilityMult,
  grade,
  safetyScore,
  adjustedRiskPenalty,
  sourceRiskPenalty,
  sourceRiskDriverLabel,
}: WhyPysStripMobileProps) {
  const benchSpreadValue = benchmarkSpread !== null ? formatSignedPercent(benchmarkSpread, 1) : "—";
  const benchSubLabel = benchmarkLabel ? `vs ${benchmarkLabel}` : "Benchmark unavailable";
  const stabilityValue = stabilityPct !== null ? `${stabilityPct}%` : "—";
  const stabilitySub = sustainabilityMult === PYS_SUSTAINABILITY_FLOOR ? "(floor)" : "30d APY variance";
  const safetyValue =
    grade && grade !== "NR"
      ? grade
      : safetyScore !== null
      ? `${Math.round(safetyScore)}/100`
      : "—";
  const safetySub = `÷${adjustedRiskPenalty.toFixed(1)}× penalty`;
  const sourceRiskValue = `${sourceRiskPenalty.toFixed(2)}×`;
  const sourceRiskSub = sourceRiskPenalty === 1 ? "Neutral" : sourceRiskDriverLabel ?? "Neutral";

  const cells: Array<{ title: string; value: string; sublabel: string }> = [
    { title: "Bench spread", value: benchSpreadValue, sublabel: benchSubLabel },
    { title: "Stability", value: stabilityValue, sublabel: stabilitySub },
    { title: "Safety", value: safetyValue, sublabel: safetySub },
    { title: "Source risk", value: sourceRiskValue, sublabel: sourceRiskSub },
  ];

  return (
    <div
      role="group"
      aria-label="Why this PYS"
      className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {cells.map((cell) => (
        <div
          key={cell.title}
          aria-label={`${cell.title}: ${cell.value}, ${cell.sublabel}`}
          className="rounded-lg border border-border/60 bg-background/55 px-3 py-2"
        >
          <p className="text-xs text-muted-foreground">{cell.title}</p>
          <p className="font-mono tabular-nums text-sm text-foreground">{cell.value}</p>
          <p className="truncate text-[10px] text-muted-foreground">{cell.sublabel}</p>
        </div>
      ))}
    </div>
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
  const rankAttribution = row.rankChangeAttribution ?? null;
  const pysNullReasonText =
    row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null;

  let rankChip: {
    arrow: string;
    colorClass: string;
    signedRank: string;
    short: string;
    long: string;
    pysDeltaLabel: string | null;
  } | null = null;
  if (rankAttribution) {
    const { rankDelta, pysDelta, primaryDriver } = rankAttribution;
    if (rankDelta != null && primaryDriver != null && Math.abs(pysDelta ?? 0) >= 1) {
      const driver = YIELD_RANK_CHANGE_DRIVER_LABELS[primaryDriver];
      if (driver) {
        const arrow = rankDelta < 0 ? "▲" : rankDelta > 0 ? "▼" : "■";
        const colorClass =
          rankDelta < 0
            ? "text-emerald-700 dark:text-emerald-400"
            : rankDelta > 0
            ? "text-red-700 dark:text-red-400"
            : "text-muted-foreground";
        const signedRank = rankDelta < 0 ? `+${Math.abs(rankDelta)}` : rankDelta > 0 ? `-${rankDelta}` : "0";
        rankChip = {
          arrow,
          colorClass,
          signedRank,
          short: driver.short,
          long: driver.long,
          pysDeltaLabel: pysDelta != null ? formatSignedPysDelta(pysDelta) : null,
        };
      }
    }
  }

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
  const cohortChip = renderCohortChip(readCohortPercentile(row));

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
          <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} />
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
                {cohortChip}
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
        <YieldSourceLink
          href={row.yieldSourceUrl}
          className="min-h-11 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium"
          iconClassName="h-3.5 w-3.5"
        >
          Provider
        </YieldSourceLink>
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
            <WhyPysStripMobile
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
