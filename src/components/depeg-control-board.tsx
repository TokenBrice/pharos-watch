"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { FilterSearchInput } from "@/components/filter-search-input";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { DEWSBadge } from "@/components/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { compareDepegTrackerRows, type DepegTableSortKey } from "@/components/depeg-table-logic";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { cn } from "@/lib/utils";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import {
  statusLabel,
  statusClassName,
  rowToneClassName,
  metricTone,
} from "@/components/depeg-board-model";
import { DeviationBar, LinearGauge, EventLoadMeter } from "@/components/depeg-board-primitives";
import type { PegCurrency, GovernanceType } from "@shared/types";
import { GOVERNANCE_FILTER_OPTIONS, PEG_FILTER_OPTIONS } from "@shared/lib/classification";
import { formatCurrency, formatElapsedSeconds, formatPercent, formatTrackingSpanDays } from "@shared/lib/format";
import type { ThreatBand } from "@shared/lib/classification";

export { getDeviationBarWidthPercent } from "@/components/depeg-board-model";

interface DepegControlBoardProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  pegFilter: PegCurrency | "all";
  typeFilter: GovernanceType | "all";
  searchQuery: string;
  onPegFilterChange: (v: PegCurrency | "all") => void;
  onTypeFilterChange: (v: GovernanceType | "all") => void;
  onSearchChange: (v: string) => void;
  onClearFilters: () => void;
  onRowClick: (id: string) => void;
  nowSeconds: number;
  /** Assets whose event history is too short to score, shown as scope context. */
  eventFloorCount?: number;
}

const BOARD_PAGE_SIZE = 12;

const SORT_MODES: Array<{ key: DepegTableSortKey; label: string }> = [
  { key: "__attention", label: "Attention" },
  { key: "currentDeviationBps", label: "Deviation" },
  { key: "dewsScore", label: "DEWS" },
  { key: "eventCount", label: "Events" },
];

// Column layout starts at lg, not md: the six minimum tracks plus gaps need
// ~820px and a 768px viewport gives the rows ~734px, which clipped the last
// column with no horizontal access. Below lg the rows keep the stacked
// card grammar, which preserves every field.
const BOARD_GRID_CLASS =
  "grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 lg:grid-cols-[2.5rem_minmax(11rem,1.12fr)_minmax(12rem,1fr)_minmax(7rem,0.58fr)_minmax(8rem,0.68fr)_minmax(7rem,0.58fr)] xl:grid-cols-[2.75rem_minmax(13rem,1.15fr)_minmax(13rem,1fr)_minmax(7.5rem,0.58fr)_minmax(9rem,0.72fr)_minmax(7.5rem,0.58fr)_minmax(8rem,0.62fr)]";

const METRIC_HELP = {
  deviation: "Current deviation from the peg in basis points. 100 bps equals 1%.",
  dews: "DEWS is the Depeg Early Warning Score, a 0-100 stress score. Higher is more stressed.",
  pegHealth: "Peg Health merges Peg Score, where 100 is best, with the live percent of observations holding peg.",
  events: "Confirmed depeg event count for the asset, over the span Pharos has tracked it.",
  dexCheck: "DEX check compares trusted DEX prices with the primary peg signal when available.",
};


function desktopHeaderCell(label: string, className?: string, title?: string) {
  return (
    <div
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
        title ? "pharos-focus-ring rounded-sm" : "",
        className,
      )}
      title={title}
      tabIndex={title ? 0 : undefined}
      aria-label={title ? `${label}: ${title}` : undefined}
    >
      {label}
    </div>
  );
}

function MetricCell({
  label,
  value,
  children,
  subline,
  className,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
  subline?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2 lg:hidden">
        <span className="pharos-kicker">{label}</span>
        <span className="pharos-numeric text-sm font-semibold text-foreground">{value}</span>
      </div>
      <div className="pharos-numeric hidden text-sm font-semibold text-foreground lg:block">{value}</div>
      {children ? <div className="mt-1.5">{children}</div> : null}
      {subline ? <div className="pharos-meta pharos-numeric mt-1 truncate">{subline}</div> : null}
    </div>
  );
}

function InstrumentRow({
  row,
  rank,
  logos,
  onRowClick,
  nowSeconds,
}: {
  row: DepegTrackerRow;
  rank: number;
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
  nowSeconds: number;
}) {
  const prefetch = usePrefetchStablecoin();
  const coin = row.coin;
  const absDev = Math.abs(coin.currentDeviationBps ?? 0);
  const trackingSpan = formatTrackingSpanDays(coin.trackingSpanDays);
  const pegHealthValue =
    coin.pegScore !== null ? (
      <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span>
    ) : (
      <span className="text-muted-foreground">NR</span>
    );
  const eventAge =
    row.pendingIncident?.ageSec != null
      ? formatElapsedSeconds(row.pendingIncident.ageSec)
      : coin.lastEventAt != null
        ? `${formatElapsedSeconds(Math.max(0, nowSeconds - coin.lastEventAt))} ago`
        : "clear";
  return (
    <button
      type="button"
      onClick={() => onRowClick(coin.id)}
      onMouseEnter={() => prefetch(coin.id)}
      className={cn(
        BOARD_GRID_CLASS,
        "items-center border-b border-border/55 px-3 py-2.5 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        rowToneClassName(row),
      )}
      aria-label={`Open ${coin.symbol} depeg detail`}
    >
      <div className="pharos-numeric pt-0.5 text-xs text-muted-foreground lg:text-right">#{rank}</div>
      <div className="min-w-0">
        <StablecoinIdentity
          logoSrc={logos?.[coin.id]}
          name={coin.name}
          symbol={coin.symbol}
          logoSize={22}
          symbolClassName="text-sm font-semibold"
          badge={<span className="hidden truncate text-xs text-muted-foreground sm:inline">{coin.name}</span>}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-semibold uppercase leading-none", statusClassName(row))}>
            {statusLabel(row)}
          </span>
          <span className="pharos-meta pharos-numeric">{eventAge}</span>
          <span className="pharos-meta pharos-numeric">{coin.pegCurrency}</span>
        </div>
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3 lg:contents">
        <MetricCell
          className="col-span-2 lg:col-span-1"
          label="Deviation"
          value={
            <span className={cn(deviationColorClass(absDev))}>
              {coin.currentDeviationBps != null ? `${coin.currentDeviationBps > 0 ? "+" : ""}${coin.currentDeviationBps} bps` : "—"}
            </span>
          }
          subline={coin.worstDeviationBps != null ? `worst ${coin.worstDeviationBps > 0 ? "+" : ""}${coin.worstDeviationBps} bps` : "worst —"}
        >
          <DeviationBar bps={coin.currentDeviationBps} />
        </MetricCell>
        <MetricCell
          label="DEWS"
          value={row.dews ? row.dews.score : "—"}
          subline={row.dews?.band ? `${row.dews.band.toLowerCase()} band` : "no signal"}
        >
          <div className="flex min-h-5 items-center gap-2">
            {row.dews ? <DEWSBadge score={row.dews.score} band={row.dews.band as ThreatBand} compact signals={row.dews.signals} /> : <span className="text-xs text-muted-foreground">—</span>}
          </div>
        </MetricCell>
        <MetricCell
          label="Peg health"
          value={pegHealthValue}
          subline={`${formatPercent(coin.pegPct, 1)} at peg`}
        >
          <LinearGauge value={coin.pegScore} tone={metricTone(coin.pegScore)} ariaLabel={`Peg score for ${coin.symbol}`} />
        </MetricCell>
        <MetricCell
          label="Events"
          value={coin.eventCount}
          subline={coin.eventCount > 0 ? `over ${trackingSpan}` : "no history"}
        >
          <EventLoadMeter count={coin.eventCount} symbol={coin.symbol} />
        </MetricCell>
        <div className="hidden xl:block">
          <MetricCell
            label="DEX check"
            value={coin.dexPriceCheck ? (coin.dexPriceCheck.agrees ? "agree" : "diverge") : "—"}
            subline={coin.dexPriceCheck ? `${coin.dexPriceCheck.sourcePools} pools · ${formatCurrency(coin.dexPriceCheck.sourceTvl)}` : formatTrackingSpanDays(coin.trackingSpanDays)}
          />
        </div>
      </div>
    </button>
  );
}

export function DepegControlBoard({
  rows,
  logos,
  pegFilter,
  typeFilter,
  searchQuery,
  onPegFilterChange,
  onTypeFilterChange,
  onSearchChange,
  onClearFilters,
  onRowClick,
  nowSeconds,
  eventFloorCount,
}: DepegControlBoardProps) {
  const warningCount = rows.filter((row) => row.coin.activeDepeg || row.pendingIncident || (row.dews?.score ?? 0) >= 36).length;
  const filtersActive = pegFilter !== "all" || typeFilter !== "all" || searchQuery.length > 0;

  const {
    sortKey,
    sortDirection,
    toggleSort,
    handleSortKeyDown,
    effectivePage,
    totalPages,
    paginatedRows,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows: sortedTotalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<DepegTrackerRow, DepegTableSortKey>(rows, {
    defaultKey: "__attention",
    defaultDirection: "desc",
    compareRows: compareDepegTrackerRows,
    pageSize: BOARD_PAGE_SIZE,
  });

  return (
    <section id="data" aria-label="Depeg control board" tabIndex={-1} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="pharos-kicker">Leaderboard controls</p>
          <h2 className="pharos-section-title mt-1">Peg control board</h2>
        </div>
        <p className="pharos-meta">
          <span className="pharos-numeric font-semibold text-foreground">{warningCount}</span>{" "}
          {filtersActive ? "filtered coins need attention" : "need attention"}
          {eventFloorCount ? (
            <>
              {" · "}
              <span className="pharos-numeric font-semibold text-foreground">{eventFloorCount}</span>{" "}
              below the event-history floor
            </>
          ) : null}
        </p>
      </div>

      <div className="pharos-table-shell">
        <div className="pharos-table-toolbar">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by peg currency">
              {PEG_FILTER_OPTIONS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => onPegFilterChange(f.value as PegCurrency | "all")}
                  aria-pressed={pegFilter === f.value}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill",
                    pegFilter === f.value ? "pharos-control-pill-active" : "",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by governance type">
              {GOVERNANCE_FILTER_OPTIONS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => onTypeFilterChange(f.value as GovernanceType | "all")}
                  aria-pressed={typeFilter === f.value}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill",
                    typeFilter === f.value ? "pharos-control-pill-active" : "",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <FilterSearchInput
              value={searchQuery}
              onValueChange={onSearchChange}
              placeholder="Search..."
              className="relative w-full sm:w-44"
              inputClassName="pl-8 h-11 md:h-8 text-xs"
              ariaLabel="Search stablecoins by name or symbol"
            />
            {filtersActive ? (
              <button
                type="button"
                onClick={onClearFilters}
                className="pharos-focus-ring pharos-control-pill gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Clear filters
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {SORT_MODES.map((mode) => (
                <button
                  type="button"
                  key={mode.key}
                  onClick={() => toggleSort(mode.key)}
                  onKeyDown={(event) => handleSortKeyDown(event, mode.key)}
                  aria-pressed={sortKey === mode.key}
                  aria-label={`${mode.label} sort${sortKey === mode.key ? `, ${sortDirection}` : ""}`}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill",
                    sortKey === mode.key ? "pharos-control-pill-active" : "",
                  )}
                >
                  <span>{mode.label}</span>
                  {sortKey === mode.key ? (
                    sortDirection === "asc" ? (
                      <ArrowUp className="ml-1 inline h-3 w-3" aria-label="ascending" />
                    ) : (
                      <ArrowDown className="ml-1 inline h-3 w-3" aria-label="descending" />
                    )
                  ) : null}
                </button>
              ))}
            </div>
            <div className="pharos-numeric text-xs text-muted-foreground">
              {rangeStart}-{rangeEnd} / {sortedTotalRows}
            </div>
          </div>
          <div className={cn(BOARD_GRID_CLASS, "hidden border-b border-border/60 bg-background/45 px-3 py-2 lg:grid")}>
            {desktopHeaderCell("#", "text-right")}
            {desktopHeaderCell("Asset")}
            {desktopHeaderCell("Deviation", undefined, METRIC_HELP.deviation)}
            {desktopHeaderCell("DEWS", undefined, METRIC_HELP.dews)}
            {desktopHeaderCell("Peg health", undefined, METRIC_HELP.pegHealth)}
            {desktopHeaderCell("Events", undefined, METRIC_HELP.events)}
            {desktopHeaderCell("DEX check", "hidden xl:block", METRIC_HELP.dexCheck)}
          </div>
          <div className="divide-y divide-border/55">
            {paginatedRows.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                <p>No stablecoins match these filters.</p>
                {filtersActive ? (
                  <button
                    type="button"
                    onClick={onClearFilters}
                    className="pharos-focus-ring pharos-control-pill mt-3 gap-1.5"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              paginatedRows.map((row, index) => (
                <InstrumentRow
                  key={row.coin.id}
                  row={row}
                  rank={pageStartIndex + index + 1}
                  logos={logos}
                  onRowClick={onRowClick}
                  nowSeconds={nowSeconds}
                />
              ))
            )}
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-2">
              <button
                type="button"
                onClick={onPreviousPage}
                disabled={effectivePage <= 0}
                className="pharos-focus-ring pharos-control-pill disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="pharos-numeric text-xs text-muted-foreground">
                page {effectivePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={onNextPage}
                disabled={effectivePage >= totalPages - 1}
                className="pharos-focus-ring pharos-control-pill disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
