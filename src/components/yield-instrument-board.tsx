"use client";

import { QUALITY_TIER_3_CLASSES, REPORT_CARD_GRADE_RANGE_METADATA, getPysBarColor } from "@shared/lib/classification";
import { gradeRange, scoreToGrade } from "@shared/lib/report-card-core";

import Link from "next/link";
import { memo, useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { MethodologyHint } from "@/components/methodology-hint";
import { TablePagination, type TablePaginationProps } from "@/components/table-pagination";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { YieldCohortChip } from "@/components/yield-cohort-chip";
import { YieldZoneChip } from "@/components/yield-zone-chip";
import {
  ApyRangeBar,
  YieldExpandedDetails,
  YieldPysValue,
  YieldSafetyBadge,
  isOpportunityDerivedYieldRow,
  YieldSignalsIndicator,
  YieldSourceDetails,
  deriveYieldRowDisplay,
} from "@/components/yield-leaderboard-row-parts";
import type { YieldSourceDisplayClock } from "@/lib/yield-source-presentation";
import { cn } from "@/lib/utils";
import { getYieldWorkbenchLink } from "@/lib/yield-workbench-link";
import type { YieldBenchmarkRegistry } from "@shared/types";
import { trackEvent } from "@/lib/analytics";
import { resolveYieldDisplayRebaseReferenceRate, resolveYieldRowBenchmark } from "@/lib/yield-benchmark";
import type { YieldTableSortKey } from "@/components/yield-table-logic";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { getLogoSrc } from "@/lib/logos";
import { clampScore } from "@shared/lib/math";
import { formatYieldApyDelta } from "@/lib/yield-presentation";

// ---------------------------------------------------------------------------
// Visual-indicator primitives. The board mirrors the depeg control board: each
// decision metric reads as a prominent value + a thin severity-tinted bar. Only
// the three ranking drivers (APY, Safety, PYS) are gauged; TVL / Stability /
// 30d-Range stay as plain values. Tailwind classes are static strings.
// ---------------------------------------------------------------------------

// Gauge tone follows the V9 grade ladder via scoreToGrade, so a row's gauge
// can never disagree with its adjacent grade badge; bar classes come from the
// classification grade-range table (A emerald / B blue / C amber / D orange /
// F red). The old hardcoded 80/60/40 cuts gave a C+ (60-64) a blue gauge
// under an amber badge.
function safetyBarTone(score: number | null): string {
  if (score == null) return "bg-muted-foreground/40";
  return REPORT_CARD_GRADE_RANGE_METADATA[gradeRange(scoreToGrade(score))].barClassName;
}

function MetricGauge({
  value,
  max = 100,
  tone,
  ariaLabel,
}: {
  value: number | null;
  max?: number;
  tone: string;
  ariaLabel: string;
}) {
  const pct = value == null ? 0 : clampScore((value / max) * 100);
  return (
    <div role="img" aria-label={ariaLabel} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", tone)}
        style={{ width: value == null ? "0%" : `${Math.max(3, pct)}%` }}
      />
    </div>
  );
}

// APYs cluster in the 3-15% band with occasional 30-60% outliers; saturate the
// bar at 20% so the common band stays visually differentiated.
function scaleApy(apy: number): number {
  return clampScore((apy / 20) * 100);
}

function ApyBenchmarkBar({ apy30d, benchmarkRate }: { apy30d: number; benchmarkRate: number | null }) {
  const fillWidth = Math.max(3, scaleApy(apy30d));
  const benchPos = benchmarkRate != null ? clampScore(scaleApy(benchmarkRate)) : null;
  const excess = benchmarkRate != null ? apy30d - benchmarkRate : null;
  const tone =
    excess == null
      ? QUALITY_TIER_3_CLASSES.good.bar
      : excess >= 0.5
        ? QUALITY_TIER_3_CLASSES.good.bar
        : excess >= -0.5
          ? QUALITY_TIER_3_CLASSES.watch.bar
          : QUALITY_TIER_3_CLASSES.bad.bar;
  return (
    <div
      role="img"
      aria-label={`30-day APY ${apy30d.toFixed(1)} percent${
        benchmarkRate != null ? `, benchmark ${benchmarkRate.toFixed(1)} percent` : ""
      }`}
      className="relative h-2.5 w-full"
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${fillWidth}%` }} />
      </div>
      {benchPos != null ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 rounded-full bg-foreground/55"
          style={{ left: `${benchPos}%` }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid scaffolding. One parent grid owns the column template; the header and
// every row are subgrids spanning all columns, so a column is the same width in
// every row whatever its content (a content-sized track can no longer drift per
// row), while a row can still expand into a full-width history panel.
// Visible-child count must match the track count at each breakpoint: md shows
// 7 columns, lg adds TVL + Stability (9), xl adds 30d-Range (10).
// ---------------------------------------------------------------------------

const BOARD_GRID_CLASS =
  "grid w-full grid-cols-1 gap-x-3 " +
  "md:grid-cols-[2.5rem_minmax(11rem,1.4fr)_minmax(8rem,1fr)_minmax(6rem,0.7fr)_minmax(8rem,1fr)_minmax(10rem,1.2fr)_minmax(4.5rem,auto)] " +
  "lg:grid-cols-[2.5rem_minmax(11rem,1.4fr)_minmax(8rem,1fr)_minmax(6rem,0.7fr)_minmax(8rem,1fr)_minmax(11rem,1.6fr)_minmax(6rem,0.7fr)_minmax(5.5rem,0.6fr)_minmax(4.5rem,auto)] " +
  "xl:grid-cols-[2.75rem_minmax(12rem,1.5fr)_minmax(8.5rem,1fr)_minmax(6.5rem,0.7fr)_minmax(8.5rem,1fr)_minmax(13rem,1.9fr)_minmax(6rem,0.7fr)_minmax(5.5rem,0.6fr)_5rem_minmax(5rem,auto)]";

const BOARD_SUBGRID_CLASS = "col-span-full grid grid-cols-subgrid items-start";

const SORT_PILLS: ReadonlyArray<{ key: YieldTableSortKey; label: string }> = [
  { key: "pys", label: "PYS" },
  { key: "apy30d", label: "APY" },
  { key: "safetyScore", label: "Safety" },
  { key: "tvl", label: "TVL" },
  { key: "yieldStability", label: "Stability" },
  { key: "yieldType", label: "Type" },
];

function HeaderCell({
  label,
  className,
  adornment,
  title,
}: {
  label: string;
  className?: string;
  adornment?: ReactNode;
  title?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 pharos-label",
        className,
      )}
      title={title}
    >
      <span>{label}</span>
      {adornment}
    </div>
  );
}

function MetricLabel({ children }: { children: ReactNode }) {
  // The grid header carries column labels at lg+; the md tier hides that header,
  // so each cell self-labels there and the per-row label is suppressed at lg+.
  return (
    <span className="block pharos-label lg:hidden">
      {children}
    </span>
  );
}

function rowToneClass(warningCount: number, sourceRiskMaterial: boolean): string {
  if (warningCount >= 2) return "bg-state-warn-solid/[0.06]";
  if (warningCount === 1 || sourceRiskMaterial) return "bg-state-warn-solid/[0.035]";
  return "";
}

interface YieldInstrumentRowProps {
  row: YieldViewModelRow;
  rank: number;
  logo?: string;
  riskFreeRate: number;
  medianApy: number | null;
  scalingFactor: number;
  /**
   * Benchmark registry from the payload. Lets a row with no published rate
   * resolve its zone-chip benchmark from its own benchmarkKey instead of the
   * chart-wide USD frame.
   */
  benchmarks?: YieldBenchmarkRegistry | null;
  /** Payload methodology version; gates the v8.43 re-base reference during a deploy window. */
  methodologyVersion?: string | null;
  /** Parent-sampled source clock; rows re-derive source-age display at its crossings. */
  sourceClock?: YieldSourceDisplayClock | null;
  expanded: boolean;
  isCompared: boolean;
  compareDisabled: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
  onToggleCompare: (stablecoinId: string) => void;
}

function YieldInstrumentRowBase({
  row,
  rank,
  logo,
  riskFreeRate,
  medianApy,
  scalingFactor,
  benchmarks = null,
  methodologyVersion = null,
  sourceClock = null,
  expanded,
  isCompared,
  compareDisabled,
  onPrefetch,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
}: YieldInstrumentRowProps) {
  const {
    grade,
    safetyScore,
    pysColor,
    breakdown,
    confidenceStyle,
    confidenceLabel,
    freshness,
    sourceRiskScore,
    sourceRiskMaterial,
    sourceRiskDrivers,
    rankChip,
    pysNullReasonText,
    availableSources,
    altSourceCount,
    benchmarkReferenceText,
    isCurrencyMismatchedBenchmark,
    warningCount,
    ...labels
  } = useMemo(
    () =>
      deriveYieldRowDisplay(
        row,
        scalingFactor,
        // Version-gated: pre-8.43 payloads were scored without the re-base.
        resolveYieldDisplayRebaseReferenceRate(methodologyVersion, riskFreeRate, benchmarks?.USD),
        sourceClock,
      ),
    [row, scalingFactor, methodologyVersion, riskFreeRate, benchmarks, sourceClock],
  );
  const totalSourceCount = 1 + altSourceCount;
  const workbenchLink = getYieldWorkbenchLink(row.id);
  const resolvedBenchmark = resolveYieldRowBenchmark(row, benchmarks, riskFreeRate);
  const benchmarkRate = resolvedBenchmark.rate;
  const excess = benchmarkRate != null ? row.apy30d - benchmarkRate : null;
  // A default-safety score is a scoring input, not a measured Safety Score: the
  // badge, gauge and zone verdict read it as unavailable.
  const usedDefaultSafety = row.provenance?.usedDefaultSafety === true;
  const displayedSafetyScore = usedDefaultSafety ? null : safetyScore;

  return (
    <div className={cn(BOARD_SUBGRID_CLASS, "border-b border-border/55 last:border-b-0")}>
      {/* Not a <button>/role="button": the row nests focusable controls (compare
          checkbox, watchlist star, deep-dive link, expand toggle), so a row-level
          button would be invalid (nested-interactive). Row click is a pointer
          convenience; the keyboard-reachable expand control is the chevron. */}
      <div
        id={`yield-row-${row.id}`}
        data-yield-row-display={row.id}
        data-yield-grade={grade ?? "NR"}
        data-yield-safety-score={safetyScore ?? ""}
        data-yield-pys={row.pharosYieldScore ?? ""}
        data-yield-source-risk={sourceRiskScore ?? ""}
        data-yield-freshness={freshness?.displayText ?? ""}
        data-yield-warning-count={warningCount}
        data-yield-benchmark={benchmarkReferenceText}
        onClick={() => onToggleExpanded(row.id)}
        onMouseEnter={() => onPrefetch(row.id)}
        className={cn(
          BOARD_SUBGRID_CLASS,
          "cursor-pointer px-3 py-2.5 transition-colors hover:bg-muted/30",
          rowToneClass(warningCount, sourceRiskMaterial),
        )}
      >
        {/* Rank */}
        <div className="hidden pt-1 text-right font-mono text-xs tabular-nums text-muted-foreground md:block">
          <span className="sr-only">{row.rankLabel}</span>
          <span aria-hidden="true">{rank}</span>
        </div>

        {/* Coin: compare + logo + symbol + star + name, then type badge + warnings */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isCompared}
              disabled={compareDisabled}
              onChange={() => onToggleCompare(row.id)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              aria-label={`Add ${row.symbol} to compare`}
              className="pharos-focus-ring h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border border-border/70 bg-background/60 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <StablecoinLogo src={logo} name={row.name} size={24} />
            <span className="font-medium">{row.symbol}</span>
            <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} className="h-6 w-6" />
            <span className="hidden max-w-[150px] truncate text-xs text-muted-foreground xl:inline">{row.name}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={`text-3xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
              {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
            </Badge>
            <YieldZoneChip safetyScore={displayedSafetyScore} apy30d={row.apy30d} benchmarkRate={resolvedBenchmark.rate} />
            <YieldSignalsIndicator
              row={row}
              sourceRiskSummary={labels.sourceRiskSummary}
            />
          </div>
        </div>

        {/* APY (gauged) */}
        <div className="min-w-0">
          <MetricLabel>APY 30d</MetricLabel>
          <div className="font-mono text-lg font-semibold leading-none tabular-nums">
            <span className="sr-only">{labels.apySrLabel}</span>
            <span aria-hidden="true">{labels.apyLabel}</span>
          </div>
          <div className="mt-1.5">
            <ApyBenchmarkBar apy30d={row.apy30d} benchmarkRate={benchmarkRate} />
          </div>
          <div className="mt-1 truncate font-mono text-3xs text-muted-foreground">
            {excess != null ? (
              <span>
                {formatYieldApyDelta(excess)} vs {resolvedBenchmark.label}
              </span>
            ) : (
              <span>{resolvedBenchmark.label}</span>
            )}
          </div>
        </div>

        {/* Safety (gauged) */}
        <div className="min-w-0">
          <MetricLabel>Safety</MetricLabel>
          <div className="leading-none">
            <YieldSafetyBadge
              grade={grade}
              safetyScore={safetyScore}
              safetySrLabel={labels.safetySrLabel}
              opportunityDerived={isOpportunityDerivedYieldRow(row)}
              usedDefaultSafety={usedDefaultSafety}
            />
          </div>
          <div className="mt-1.5">
            <MetricGauge
              value={displayedSafetyScore}
              tone={safetyBarTone(displayedSafetyScore)}
              ariaLabel={`Safety score ${displayedSafetyScore !== null ? Math.round(displayedSafetyScore) : "unavailable"} of 100`}
            />
          </div>
          <div className="mt-1 truncate font-mono text-3xs text-muted-foreground">
            {displayedSafetyScore !== null ? `${Math.round(displayedSafetyScore)}/100` : "unscored"}
          </div>
        </div>

        {/* PYS (gauged, hero) */}
        <div className="min-w-0">
          <MetricLabel>PYS</MetricLabel>
          <div>
            <span className="sr-only">{labels.pysSrLabel}</span>
            <YieldPysValue
              row={row}
              grade={grade}
              safetyScore={safetyScore}
              pysColor={pysColor}
              pysNullReasonText={pysNullReasonText}
              isCurrencyMismatchedBenchmark={isCurrencyMismatchedBenchmark}
              sourceRiskDrivers={sourceRiskDrivers}
              breakdown={breakdown}
              rankChip={rankChip}
            />
          </div>
          <div className="mt-1.5">
            <MetricGauge
              value={row.pharosYieldScore}
              tone={getPysBarColor(row.pharosYieldScore)}
              ariaLabel={`Pharos Yield Score ${row.pharosYieldScore ?? "unavailable"} of 100`}
            />
          </div>
          <div className="mt-1 truncate text-3xs text-muted-foreground">
            <YieldCohortChip cohort={row.cohortPercentile} />
          </div>
        </div>

        {/* Source */}
        <div className="min-w-0">
          <MetricLabel>Source</MetricLabel>
          <div className="mt-0.5">
            <YieldSourceDetails
              row={row}
              confidenceStyle={confidenceStyle}
              confidenceLabel={confidenceLabel}
              freshness={freshness}
            />
          </div>
        </div>

        {/* TVL (plain, lg+) */}
        <div className="hidden min-w-0 lg:block">
          <MetricLabel>TVL</MetricLabel>
          <div
            className={
              labels.tvlIsNative
                ? "font-mono text-sm text-muted-foreground"
                : "font-mono text-sm font-medium tabular-nums"
            }
          >
            <span className="sr-only">{labels.tvlSrLabel}</span>
            <span aria-hidden="true">{labels.tvlLabel}</span>
          </div>
        </div>

        {/* Stability (plain, lg+) */}
        <div className="hidden min-w-0 lg:block">
          <MetricLabel>Stability</MetricLabel>
          <div className="font-mono text-sm font-medium tabular-nums">
            <span className="sr-only">{labels.stabilitySrLabel}</span>
            {labels.stabilityPct !== null ? (
              <span aria-hidden="true">{labels.stabilityPct}%</span>
            ) : (
              <span className="text-muted-foreground">{"—"}</span>
            )}
          </div>
        </div>

        {/* 30d Range (plain marker, xl+) */}
        <div className="hidden min-w-0 xl:block">
          <MetricLabel>30d Range</MetricLabel>
          <div className="mt-1">
            {row.apyMin30d !== null && row.apyMax30d !== null ? (
              <ApyRangeBar currentApy={row.currentApy} min={row.apyMin30d} max={row.apyMax30d} />
            ) : (
              <span className="text-xs text-muted-foreground">{"—"}</span>
            )}
          </div>
        </div>

        {/* Actions: deep dive + expand */}
        <div className="flex items-center justify-end gap-1 md:pt-0.5">
          <Link
            href={workbenchLink.href}
            prefetch={false}
            onClick={(event) => {
              event.stopPropagation();
              trackEvent("yield_row_action", {
                action: "deep_dive_opened",
                coin_id: row.id,
                warning_count: warningCount,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            className="pharos-focus-ring hidden items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:inline-flex"
            aria-label={`${workbenchLink.label} for ${row.symbol}`}
            title={workbenchLink.label}
          >
            <span className="truncate">{workbenchLink.isWorkbench ? "Deep dive" : "Opportunities"}</span>
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(row.id);
            }}
            className="pharos-focus-ring inline-flex items-center justify-center rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={expanded ? `Hide ${row.symbol} yield history` : `Show ${row.symbol} yield history`}
            aria-expanded={expanded}
            aria-controls={`yield-row-${row.id}-details`}
            title={expanded ? "Hide yield history" : "Show yield history"}
          >
            <ChevronDown
              className={expanded ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"}
            />
          </button>
        </div>
      </div>

      {expanded ? (
        <div id={`yield-row-${row.id}-details`} className="col-span-full">
          <YieldExpandedDetails
            row={row}
            benchmark={resolvedBenchmark}
            medianApy={medianApy}
            availableSources={availableSources}
            benchmarkReferenceText={benchmarkReferenceText}
            stabilityPct={labels.stabilityPct}
            breakdown={breakdown}
            grade={grade}
            safetyScore={safetyScore}
            sourceRiskDrivers={sourceRiskDrivers}
            altSourceCount={altSourceCount}
            totalSourceCount={totalSourceCount}
            onOpenSourceSheet={onOpenSourceSheet}
          />
        </div>
      ) : null}
    </div>
  );
}

const YieldInstrumentRow = memo(YieldInstrumentRowBase);
YieldInstrumentRow.displayName = "YieldInstrumentRow";

interface YieldInstrumentBoardProps {
  rows: YieldViewModelRow[];
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number | null;
  scalingFactor: number;
  /**
   * Benchmark registry from the payload. Lets a row with no published rate
   * resolve its zone-chip benchmark from its own benchmarkKey instead of the
   * chart-wide USD frame.
   */
  benchmarks?: YieldBenchmarkRegistry | null;
  /** Payload methodology version; gates the v8.43 re-base reference during a deploy window. */
  methodologyVersion?: string | null;
  /** Parent-sampled source clock; rows re-derive source-age display at its crossings. */
  sourceClock?: YieldSourceDisplayClock | null;
  pageStartIndex: number;
  sortKey: YieldTableSortKey;
  sortDirection: "asc" | "desc";
  onToggleSort: (key: YieldTableSortKey) => void;
  pagination?: TablePaginationProps;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  expandedId: string | null;
  compareHas: (stablecoinId: string) => boolean;
  compareCanAdd: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
  onToggleCompare: (stablecoinId: string) => void;
  emptyMessage?: string;
}

export function YieldInstrumentBoard({
  rows,
  logos,
  riskFreeRate,
  medianApy,
  scalingFactor,
  benchmarks = null,
  methodologyVersion = null,
  sourceClock = null,
  pageStartIndex,
  sortKey,
  sortDirection,
  onToggleSort,
  pagination,
  rangeStart,
  rangeEnd,
  total,
  expandedId,
  compareHas,
  compareCanAdd,
  onPrefetch,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
  emptyMessage,
}: YieldInstrumentBoardProps) {
  return (
    <div data-testid="yield-instrument-board" className="pharos-table-shell">
      {/* Sort pills + range summary */}
      <div className="pharos-table-toolbar flex-row flex-wrap items-center justify-between">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sort yield leaderboard">
          {SORT_PILLS.map((pill) => {
            const active = sortKey === pill.key;
            return (
              <button
                type="button"
                key={pill.key}
                onClick={() => onToggleSort(pill.key)}
                aria-pressed={active}
                aria-label={`${pill.label} sort${active ? `, ${sortDirection}` : ""}`}
                className={cn(
                  "pharos-focus-ring rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-foreground text-background"
                    : "border-border/70 bg-background/45 text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{pill.label}</span>
                {active ? (
                  sortDirection === "asc" ? (
                    <ArrowUp className="ml-1 inline h-3 w-3" aria-label="ascending" />
                  ) : (
                    <ArrowDown className="ml-1 inline h-3 w-3" aria-label="descending" />
                  )
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          {rangeStart}-{rangeEnd} / {total}
        </div>
      </div>

      {/* Grid header (lg+: the md tier relies on per-cell labels to stay legible) */}
      <div className={BOARD_GRID_CLASS}>
      <div className={cn(BOARD_SUBGRID_CLASS, "hidden border-b border-border/60 bg-background/45 px-3 py-2 lg:grid")}>
        <HeaderCell label="#" className="justify-end" />
        <HeaderCell label="Coin" />
        <HeaderCell label="APY 30d" title="30-day average annual percentage yield" />
        <HeaderCell label="Safety" title="Pharos Safety Grade / Score" />
        <HeaderCell
          label="PYS"
          adornment={<MethodologyHint topic="pys" />}
          title="Pharos Yield Score: is this APY paying enough for the risk? Yield per unit of risk, not a recommendation"
        />
        <HeaderCell label="Source" />
        <HeaderCell label="TVL" title="Total value locked in yield source" />
        <HeaderCell
          label="Stability"
          adornment={<MethodologyHint topic="yieldStability" />}
          title="Yield stability over 30 days"
        />
        <HeaderCell label="30d Range" className="hidden xl:flex" />
        <HeaderCell label="" className="justify-end" />
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <div className="col-span-full px-3 py-12 text-center text-sm text-muted-foreground">
          {emptyMessage ?? "No yield data available."}
        </div>
      ) : (
        <>
          {rows.map((row, index) => (
            <YieldInstrumentRow
              key={row.id}
              row={row}
              rank={pageStartIndex + index + 1}
              logo={getLogoSrc(logos, row.id)}
              riskFreeRate={riskFreeRate}
              medianApy={medianApy}
              scalingFactor={scalingFactor}
              benchmarks={benchmarks}
              methodologyVersion={methodologyVersion}
              sourceClock={sourceClock}
              expanded={expandedId === row.id}
              isCompared={compareHas(row.id)}
              compareDisabled={!compareHas(row.id) && !compareCanAdd}
              onPrefetch={onPrefetch}
              onToggleExpanded={onToggleExpanded}
              onOpenSourceSheet={onOpenSourceSheet}
              onToggleCompare={onToggleCompare}
            />
          ))}
        </>
      )}
      </div>

      {pagination ? (
        <div className="border-t border-border/70">
          <TablePagination {...pagination} bordered={false} />
        </div>
      ) : null}
    </div>
  );
}
