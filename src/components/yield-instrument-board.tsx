"use client";

import { memo, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { MethodologyHint } from "@/components/methodology-hint";
import { TablePagination, type TablePaginationProps } from "@/components/table-pagination";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { YieldCohortChip } from "@/components/yield-cohort-chip";
import {
  ApyRangeBar,
  YieldExpandedDetails,
  YieldPysValue,
  YieldSafetyBadge,
  YieldSignalsIndicator,
  YieldSourceDetails,
  formatYieldRowLabels,
} from "@/components/yield-leaderboard-row-parts";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { computePysBreakdown, getPysColor } from "@/lib/yield-constants";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  classifyYieldSourceFreshness,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import { PYS_NULL_REASON_TEXT, buildRankChangeChipDisplay } from "@/lib/yield-presentation";
import { trackEvent } from "@/lib/analytics";
import type { YieldTableSortKey } from "@/components/yield-table-logic";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { clampScore } from "@shared/lib/math";

// ---------------------------------------------------------------------------
// Visual-indicator primitives. The board mirrors the depeg control board: each
// decision metric reads as a prominent value + a thin severity-tinted bar. Only
// the three ranking drivers (APY, Safety, PYS) are gauged; TVL / Stability /
// 30d-Range stay as plain values. Tailwind classes are static strings.
// ---------------------------------------------------------------------------

// Map a 0-100 safety score to a bar tone (mirrors the 80/60/40 score tiers).
function safetyBarTone(score: number | null): string {
  if (score == null) return "bg-muted-foreground/40";
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-sky-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}

// Map a PYS score to a bar tone matching getPysColor's 41/21 thresholds.
function pysBarTone(score: number | null): string {
  if (score == null) return "bg-muted-foreground/40";
  if (score >= 41) return "bg-emerald-500";
  if (score >= 21) return "bg-amber-500";
  return "bg-red-500";
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
      ? "bg-emerald-500"
      : excess >= 0.5
        ? "bg-emerald-500"
        : excess >= -0.5
          ? "bg-amber-500"
          : "bg-red-500";
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
// Grid scaffolding. Each row is its own grid (depeg pattern) so columns stay
// aligned while rows can expand into a full-width history panel between them.
// Visible-child count must match the track count at each breakpoint: md shows
// 7 columns, lg adds TVL + Stability (9), xl adds 30d-Range (10).
// ---------------------------------------------------------------------------

const BOARD_GRID_CLASS =
  "grid w-full grid-cols-1 items-start gap-x-3 " +
  "md:grid-cols-[2.5rem_minmax(11rem,1.4fr)_minmax(8rem,1fr)_minmax(6rem,0.7fr)_minmax(8rem,1fr)_minmax(10rem,1.2fr)_minmax(4.5rem,auto)] " +
  "lg:grid-cols-[2.5rem_minmax(11rem,1.4fr)_minmax(8rem,1fr)_minmax(6rem,0.7fr)_minmax(8rem,1fr)_minmax(10rem,1.1fr)_minmax(6rem,0.7fr)_minmax(5.5rem,0.6fr)_minmax(4.5rem,auto)] " +
  "xl:grid-cols-[2.75rem_minmax(12rem,1.5fr)_minmax(8.5rem,1fr)_minmax(6.5rem,0.7fr)_minmax(8.5rem,1fr)_minmax(11rem,1.2fr)_minmax(6rem,0.7fr)_minmax(5.5rem,0.6fr)_5rem_minmax(5rem,auto)]";

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
        "flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
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
    <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground lg:hidden">
      {children}
    </span>
  );
}

function rowToneClass(warningCount: number, sourceRiskMaterial: boolean): string {
  if (warningCount >= 2) return "bg-amber-500/[0.06]";
  if (warningCount === 1 || sourceRiskMaterial) return "bg-amber-500/[0.035]";
  return "";
}

interface YieldInstrumentRowProps {
  row: YieldViewModelRow;
  rank: number;
  logo?: string;
  riskFreeRate: number;
  medianApy: number;
  scalingFactor: number;
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
  expanded,
  isCompared,
  compareDisabled,
  onPrefetch,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
}: YieldInstrumentRowProps) {
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  const pysColor = getPysColor(row.pharosYieldScore);
  const labels = formatYieldRowLabels(row);
  const breakdown = useMemo(
    () => ({
      ...computePysBreakdown(
        row.apy30d,
        safetyScore,
        row.yieldStability,
        row.benchmarkRate,
        row.sourceRisk?.sourceRiskPenalty ?? null,
      ),
      scalingFactor,
    }),
    [row.apy30d, row.benchmarkRate, row.sourceRisk?.sourceRiskPenalty, row.yieldStability, safetyScore, scalingFactor],
  );
  const confidenceTier = row.provenance?.confidenceTier ?? null;
  const confidenceStyle = confidenceTier ? YIELD_SOURCE_CONFIDENCE_STYLES[confidenceTier] : null;
  const confidenceLabel = confidenceTier ? YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier].label : null;
  const freshness = useMemo(
    () => classifyYieldSourceFreshness(row.sourceRisk?.sourceAgeSeconds ?? null),
    [row.sourceRisk?.sourceAgeSeconds],
  );
  const sourceRiskScore = row.sourceRisk?.sourceRiskScore ?? null;
  const rawSourceRiskPenalty = row.sourceRisk?.sourceRiskPenalty ?? null;
  const sourceRiskMaterial = rawSourceRiskPenalty !== null && rawSourceRiskPenalty > 1.05;
  const rankChip = useMemo(() => buildRankChangeChipDisplay(row.rankChangeAttribution), [row.rankChangeAttribution]);
  const pysNullReasonText =
    row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null;
  const benchmarkReferenceText = useMemo(() => getYieldBenchmarkReferenceText(row), [row]);
  const sourceRiskDrivers = useMemo(
    () =>
      getYieldSourceRiskDrivers({
        sourceRisk: row.sourceRisk,
        sourceChanged: row.provenance?.sourceSwitch ?? false,
      }),
    [row.provenance?.sourceSwitch, row.sourceRisk],
  );
  const availableSources = useMemo(
    () => [
      ...(row.provenance?.sourceKey ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }] : []),
      ...(row.altSources ?? []).map((source) => ({ sourceKey: source.sourceKey, yieldSource: source.yieldSource })),
    ],
    [row],
  );

  // WHY: USD-fallback benchmark on a non-USD peg yields a currency-mismatched score; surface a caveat.
  const isCurrencyMismatchedBenchmark =
    row.benchmarkSelectionMode === "fallback-usd" && row.peg !== null && row.peg !== "USD";
  const altSourceCount = row.altSources?.length ?? 0;
  const totalSourceCount = 1 + altSourceCount;
  const warningCount = row.warningSignals.length;
  const benchmarkRate = row.benchmarkRate ?? riskFreeRate;
  const excess = benchmarkRate != null ? row.apy30d - benchmarkRate : null;

  return (
    <div className="border-b border-border/55 last:border-b-0">
      {/* Not a <button>/role="button": the row nests focusable controls (compare
          checkbox, watchlist star, deep-dive link, expand toggle), so a row-level
          button would be invalid (nested-interactive). Row click is a pointer
          convenience; the keyboard-reachable expand control is the chevron. */}
      <div
        id={`yield-row-${row.id}`}
        onClick={() => onToggleExpanded(row.id)}
        onMouseEnter={() => onPrefetch(row.id)}
        className={cn(
          BOARD_GRID_CLASS,
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
              className="pharos-focus-ring h-3.5 w-3.5 shrink-0 cursor-pointer rounded border border-border/70 bg-background/60 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <StablecoinLogo src={logo} name={row.name} size={24} />
            <span className="font-medium">{row.symbol}</span>
            <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} className="h-6 w-6" />
            <span className="hidden max-w-[150px] truncate text-xs text-muted-foreground xl:inline">{row.name}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={`text-[10px] ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
              {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
            </Badge>
            <YieldSignalsIndicator
              row={row}
              sourceRiskMaterial={sourceRiskMaterial}
              rawSourceRiskPenalty={rawSourceRiskPenalty}
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
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {excess != null ? (
              <span>
                {excess >= 0 ? "+" : ""}
                {excess.toFixed(1)}% vs {row.benchmarkLabel}
              </span>
            ) : (
              <span>{row.benchmarkLabel}</span>
            )}
          </div>
        </div>

        {/* Safety (gauged) */}
        <div className="min-w-0">
          <MetricLabel>Safety</MetricLabel>
          <div className="leading-none">
            <YieldSafetyBadge grade={grade} safetyScore={safetyScore} safetySrLabel={labels.safetySrLabel} />
          </div>
          <div className="mt-1.5">
            <MetricGauge
              value={safetyScore}
              tone={safetyBarTone(safetyScore)}
              ariaLabel={`Safety score ${safetyScore !== null ? Math.round(safetyScore) : "unavailable"} of 100`}
            />
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {safetyScore !== null ? `${Math.round(safetyScore)}/100` : "unscored"}
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
              tone={pysBarTone(row.pharosYieldScore)}
              ariaLabel={`Pharos Yield Score ${row.pharosYieldScore ?? "unavailable"} of 100`}
            />
          </div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">
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
              sourceRiskScore={sourceRiskScore}
              freshness={freshness}
            />
          </div>
        </div>

        {/* TVL (plain, lg+) */}
        <div className="hidden min-w-0 lg:block">
          <MetricLabel>TVL</MetricLabel>
          <div className="font-mono text-sm font-medium tabular-nums">
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
              <ApyRangeBar apy30d={row.apy30d} min={row.apyMin30d} max={row.apyMax30d} />
            ) : (
              <span className="text-xs text-muted-foreground">{"—"}</span>
            )}
          </div>
        </div>

        {/* Actions: deep dive + expand */}
        <div className="flex items-center justify-end gap-1 md:pt-0.5">
          <Link
            href={`${buildStablecoinUrl(row.id)}yield/`}
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
            className="pharos-focus-ring hidden items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:inline-flex"
            aria-label={`Open full yield analysis for ${row.symbol}`}
            title="Open full yield analysis"
          >
            <span>Deep dive</span>
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
        <div id={`yield-row-${row.id}-details`}>
          <YieldExpandedDetails
            row={row}
            riskFreeRate={riskFreeRate}
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
  medianApy: number;
  scalingFactor: number;
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
      <div className={cn(BOARD_GRID_CLASS, "hidden border-b border-border/60 bg-background/45 px-3 py-2 lg:grid")}>
        <HeaderCell label="#" className="justify-end" />
        <HeaderCell label="Coin" />
        <HeaderCell label="APY 30d" title="30-day average annual percentage yield" />
        <HeaderCell label="Safety" title="Pharos Safety Grade / Score" />
        <HeaderCell
          label="PYS"
          adornment={<MethodologyHint topic="pys" />}
          title="Pharos Yield Score: risk-adjusted yield ranking"
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
        <div className="px-3 py-12 text-center text-sm text-muted-foreground">
          {emptyMessage ?? "No yield data available."}
        </div>
      ) : (
        <div>
          {rows.map((row, index) => (
            <YieldInstrumentRow
              key={row.id}
              row={row}
              rank={pageStartIndex + index + 1}
              logo={logos[row.id]}
              riskFreeRate={riskFreeRate}
              medianApy={medianApy}
              scalingFactor={scalingFactor}
              expanded={expandedId === row.id}
              isCompared={compareHas(row.id)}
              compareDisabled={!compareHas(row.id) && !compareCanAdd}
              onPrefetch={onPrefetch}
              onToggleExpanded={onToggleExpanded}
              onOpenSourceSheet={onOpenSourceSheet}
              onToggleCompare={onToggleCompare}
            />
          ))}
        </div>
      )}

      {pagination ? (
        <div className="border-t border-border/70">
          <TablePagination {...pagination} bordered={false} />
        </div>
      ) : null}
    </div>
  );
}
