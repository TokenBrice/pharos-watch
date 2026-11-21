"use client";

import Link from "next/link";
import { Fragment, memo, useCallback, useMemo } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { CoinStateChip } from "@/components/coin-state-chip";
import { MethodologyHint } from "@/components/methodology-hint";
import type { TablePaginationProps } from "@/components/table-pagination";
import { YieldWatchlistStar } from "@/components/yield/yield-watchlist-star";
import { YieldCohortChip } from "@/components/yield/yield-cohort-chip";
import { YieldZoneChip } from "@/components/yield/yield-zone-chip";
import {
  ApyRangeBar,
  formatCompactBenchmarkLabel,
  YieldPysValue,
  YieldSafetyBadge,
  YieldSignalsIndicator,
  YieldSourceDetails,
} from "@/components/yield/yield-row-metrics";
import { YieldExpandedDetails } from "@/components/yield/yield-leaderboard-row-parts";
import { deriveYieldRowDisplay, isOpportunityDerivedYieldRow } from "@/lib/yield-row-display";
import type { YieldSourceDisplayClock } from "@/lib/yield-source-presentation";
import { cn } from "@/lib/utils";
import { getYieldWorkbenchLink } from "@/lib/yield-workbench-link";
import type { YieldBenchmarkRegistry } from "@shared/types/yield";
import { trackEvent } from "@/lib/analytics";
import { buildYieldPresentationContext } from "@/lib/yield-presentation-context";
import { resolveYieldRowBenchmark } from "@/lib/yield-benchmark";
import type { YieldTableSortKey } from "@/components/yield/yield-table-logic";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { getLogoSrc } from "@/lib/logos";
import { formatYieldApyDelta } from "@/lib/yield-presentation";
import { buildStablecoinUrl } from "@shared/lib/urls";

function rowToneClass(warningCount: number, sourceRiskMaterial: boolean, highlighted: boolean): string {
  if (highlighted) return "bg-accent/50 ring-2 ring-inset ring-brand-accent-text/60";
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
  highlighted: boolean;
  isCompared: boolean;
  compareDisabled: boolean;
  columnCount: number;
  onPrefetch: (stablecoinId: string) => void;
  onHoverRow?: (stablecoinId: string | null) => void;
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
  highlighted,
  isCompared,
  compareDisabled,
  columnCount,
  onPrefetch,
  onHoverRow,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
}: YieldInstrumentRowProps) {
  const {
    grade,
    safetyScore,
    pysColor,
    breakdown,
    pysDrags,
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
        buildYieldPresentationContext({ methodologyVersion, riskFreeRate, benchmarks, scalingFactor, sourceClock }),
      ),
    [row, scalingFactor, methodologyVersion, riskFreeRate, benchmarks, sourceClock],
  );
  const totalSourceCount = 1 + altSourceCount;
  const workbenchLink = getYieldWorkbenchLink(row.id);
  const resolvedBenchmark = resolveYieldRowBenchmark(row, benchmarks, riskFreeRate);
  const benchmarkRate = resolvedBenchmark.rate;
  const excess = benchmarkRate != null ? row.apy30d - benchmarkRate : null;
  const compactBenchmarkLabel = formatCompactBenchmarkLabel(resolvedBenchmark.label);
  // A default-safety score is a scoring input, not a measured Safety Score: the
  // badge and zone verdict read it as unavailable.
  const usedDefaultSafety = row.provenance?.usedDefaultSafety === true;
  const displayedSafetyScore = usedDefaultSafety ? null : safetyScore;

  return (
    <Fragment>
      {/* Not a <button>/role="button": the row nests focusable controls (compare
          checkbox, dossier link, watchlist star, deep-dive link, expand toggle).
          Row click is a pointer convenience; the keyboard-reachable expand control
          is the chevron button. */}
      <TableRow
        id={`yield-row-${row.id}`}
        rowIntent="interactive"
        data-yield-row-display={row.id}
        data-yield-grade={grade ?? "NR"}
        data-yield-safety-score={safetyScore ?? ""}
        data-yield-pys={row.pharosYieldScore ?? ""}
        data-yield-source-risk={sourceRiskScore ?? ""}
        data-yield-freshness={freshness?.displayText ?? ""}
        data-yield-warning-count={warningCount}
        data-yield-benchmark={benchmarkReferenceText}
        data-highlighted={highlighted ? "true" : undefined}
        onClick={() => onToggleExpanded(row.id)}
        onMouseEnter={() => {
          onPrefetch(row.id);
          onHoverRow?.(row.id);
        }}
        onMouseLeave={() => onHoverRow?.(null)}
        className={cn(
          "cursor-pointer align-top transition-colors",
          rowToneClass(warningCount, sourceRiskMaterial, highlighted),
        )}
      >
        <TableCell className="w-10 pt-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
          <span className="sr-only">{row.rankLabel}</span>
          <span aria-hidden="true">{rank}</span>
        </TableCell>

        <TableCell className="min-w-[13rem] max-w-[17rem]">
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
            <StablecoinLogo src={logo} name={row.name} size={22} />
            <Link
              href={buildStablecoinUrl(row.id)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              className="pharos-focus-ring truncate font-semibold text-foreground underline-offset-2 hover:underline"
            >
              {row.symbol}
            </Link>
            <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} className="h-6 w-6 shrink-0" />
          </div>
          <p className="mt-0.5 truncate pl-5 text-xs text-muted-foreground" title={row.name}>
            {row.name}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
            {row.coinStates?.[0] ? <CoinStateChip state={row.coinStates[0]} /> : null}
            <YieldZoneChip safetyScore={displayedSafetyScore} apy30d={row.apy30d} benchmarkRate={resolvedBenchmark.rate} />
            <span className="text-3xs font-medium text-muted-foreground">
              {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
            </span>
            <YieldSignalsIndicator
              row={row}
              sourceRiskSummary={labels.sourceRiskSummary}
            />
          </div>
        </TableCell>

        <TableCell className="min-w-[8.5rem]">
          <div className="font-mono text-base font-semibold leading-none tabular-nums text-foreground">
            <span className="sr-only">{labels.apySrLabel}</span>
            <span aria-hidden="true">{labels.apyLabel}</span>
          </div>
          <div
            className="mt-1.5 truncate font-mono text-3xs tabular-nums text-muted-foreground"
            title={
              excess != null
                ? `${formatYieldApyDelta(excess)} vs ${resolvedBenchmark.label}`
                : resolvedBenchmark.label
            }
          >
            {excess != null ? (
              <span>
                {formatYieldApyDelta(excess)} vs {compactBenchmarkLabel}
              </span>
            ) : (
              <span>{compactBenchmarkLabel}</span>
            )}
          </div>
        </TableCell>

        <TableCell className="min-w-[5.5rem]">
          <div className="leading-none">
            <YieldSafetyBadge
              grade={grade}
              safetyScore={safetyScore}
              safetySrLabel={labels.safetySrLabel}
              opportunityDerived={isOpportunityDerivedYieldRow(row)}
              usedDefaultSafety={usedDefaultSafety}
            />
          </div>
          <div className="mt-1.5 font-mono text-3xs tabular-nums text-muted-foreground">
            {displayedSafetyScore !== null ? `${Math.round(displayedSafetyScore)}/100` : "unscored"}
          </div>
        </TableCell>

        <TableCell className="min-w-[8rem]">
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
          <div className="mt-1.5 truncate text-3xs text-muted-foreground">
            {pysDrags.length > 0 ? (
              <span className="tabular-nums text-state-warn-bright" title="PYS points lost to this factor">
                {pysDrags.map((drag) => `−${Math.abs(drag.points)} ${drag.label}`).join(" · ")}
              </span>
            ) : (
              <YieldCohortChip cohort={row.cohortPercentile} />
            )}
          </div>
        </TableCell>

        <TableCell className="min-w-[11rem] max-w-[18rem]">
          <YieldSourceDetails
            row={row}
            confidenceStyle={confidenceStyle}
            confidenceLabel={confidenceLabel}
            freshness={freshness}
            quietConfidence
          />
        </TableCell>

        <TableCell className="hidden whitespace-nowrap text-right lg:table-cell">
          <div
            className={
              labels.tvlIsNative
                ? "font-mono text-sm text-muted-foreground"
                : "font-mono text-sm font-medium tabular-nums text-foreground"
            }
          >
            <span className="sr-only">{labels.tvlSrLabel}</span>
            <span aria-hidden="true">{labels.tvlLabel}</span>
          </div>
        </TableCell>

        <TableCell className="hidden whitespace-nowrap text-right lg:table-cell">
          <div className="font-mono text-sm font-medium tabular-nums text-foreground">
            <span className="sr-only">{labels.stabilitySrLabel}</span>
            {labels.stabilityPct !== null ? (
              <span aria-hidden="true">{labels.stabilityPct}%</span>
            ) : (
              <span className="text-muted-foreground">{"—"}</span>
            )}
          </div>
        </TableCell>

        <TableCell className="hidden whitespace-nowrap xl:table-cell">
          <div className="mt-0.5">
            {row.apyMin30d !== null && row.apyMax30d !== null ? (
              <ApyRangeBar currentApy={row.currentApy} min={row.apyMin30d} max={row.apyMax30d} />
            ) : (
              <span className="text-xs text-muted-foreground">{"—"}</span>
            )}
          </div>
        </TableCell>

        <TableCell className="whitespace-nowrap text-right">
          <div className="flex items-center justify-end gap-1">
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
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow rowIntent="static">
          <TableCell colSpan={columnCount} className="p-0">
            <div id={`yield-row-${row.id}-details`}>
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
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
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
  highlightedRowId?: string | null;
  compareHas: (stablecoinId: string) => boolean;
  compareCanAdd: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onHoverRow?: (stablecoinId: string | null) => void;
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
  expandedId,
  highlightedRowId = null,
  compareHas,
  compareCanAdd,
  onPrefetch,
  onHoverRow,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
  emptyMessage,
}: YieldInstrumentBoardProps) {
  const getAriaSortValue = useCallback(
    (key: YieldTableSortKey): "ascending" | "descending" | "none" => {
      if (sortKey !== key) return "none";
      return sortDirection === "asc" ? "ascending" : "descending";
    },
    [sortDirection, sortKey],
  );

  const columns = useMemo<readonly DataTableColumn<YieldTableSortKey>[]>(
    () => [
      { id: "rank", label: "#", className: "w-10 text-right" },
      { id: "coin", label: "Coin", className: "min-w-[13rem]" },
      {
        id: "apy30d",
        label: "APY 30d",
        sortKey: "apy30d",
        title: "30-day annual percentage yield",
        className: "min-w-[8.5rem]",
      },
      {
        id: "safetyScore",
        label: "Safety",
        sortKey: "safetyScore",
        title: "Pharos Safety Grade and Score",
        className: "min-w-[5.5rem]",
      },
      {
        id: "pys",
        label: "PYS",
        sortKey: "pys",
        headerAdornment: <MethodologyHint topic="pys" />,
        title: "Pharos Yield Score: is this APY paying enough for the risk? Yield per unit of risk, not a recommendation",
        className: "min-w-[8rem]",
      },
      { id: "source", label: "Source", className: "min-w-[11rem]" },
      {
        id: "tvl",
        label: "TVL",
        sortKey: "tvl",
        title: "Total value locked in yield source",
        className: "hidden text-right lg:table-cell",
      },
      {
        id: "yieldStability",
        label: "Stability",
        sortKey: "yieldStability",
        headerAdornment: <MethodologyHint topic="yieldStability" />,
        title: "Yield stability over 30 days",
        className: "hidden text-right lg:table-cell",
      },
      { id: "range30d", label: "30d Range", className: "hidden xl:table-cell" },
      { id: "actions", label: "", className: "w-28 text-right" },
    ],
    [],
  );

  return (
    <DataTableShell<YieldTableSortKey>
      tableId="yield-instrument-board"
      testId="yield-instrument-board"
      columns={columns}
      sort={{
        sortKey,
        sortDirection,
        toggleSort: onToggleSort,
        getAriaSortValue,
      }}
      stickyHeader
      stickyMode="page"
      pagination={pagination}
      mobileScrollHint={false}
      tableProps={{ "aria-label": "Yield leaderboard" }}
    >
      {rows.length === 0 ? (
        <DataTableEmptyRow colSpan={columns.length}>
          {emptyMessage ?? "No yield data available."}
        </DataTableEmptyRow>
      ) : (
        rows.map((row, index) => (
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
            highlighted={highlightedRowId === row.id}
            isCompared={compareHas(row.id)}
            compareDisabled={!compareHas(row.id) && !compareCanAdd}
            columnCount={columns.length}
            onPrefetch={onPrefetch}
            onHoverRow={onHoverRow}
            onToggleExpanded={onToggleExpanded}
            onOpenSourceSheet={onOpenSourceSheet}
            onToggleCompare={onToggleCompare}
          />
        ))
      )}
    </DataTableShell>
  );
}
