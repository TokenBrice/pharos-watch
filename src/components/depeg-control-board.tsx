"use client";

import type { ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, RotateCcw, ShieldCheck, Waves } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FilterSearchInput } from "@/components/filter-search-input";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { DEWSBadge } from "@/components/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { compareDepegTrackerRows, type DepegTableSortKey } from "@/components/depeg-table-logic";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { cn } from "@/lib/utils";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { clampScore } from "@shared/lib/math";
import type { PegSummaryStats } from "@shared/types";
import type { PegCurrency, GovernanceType } from "@shared/types";
import { GOVERNANCE_FILTER_OPTIONS, PEG_FILTER_OPTIONS } from "@shared/lib/classification";
import { formatCurrency, formatElapsedSeconds, formatPercent, formatTrackingSpanDays } from "@shared/lib/format";
import type { ThreatBand } from "@shared/lib/classification";

interface DepegControlBoardProps {
  rows: DepegTrackerRow[];
  stats: PegSummaryStats | null | undefined;
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
}

const BOARD_PAGE_SIZE = 12;

const SORT_MODES: Array<{ key: DepegTableSortKey; label: string }> = [
  { key: "__attention", label: "Attention" },
  { key: "currentDeviationBps", label: "Deviation" },
  { key: "dewsScore", label: "DEWS" },
  { key: "eventCount", label: "Events" },
];

const BOARD_GRID_CLASS =
  "grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[2.5rem_minmax(11rem,1.12fr)_minmax(12rem,1fr)_minmax(7rem,0.58fr)_minmax(8rem,0.68fr)_minmax(7rem,0.58fr)] xl:grid-cols-[2.75rem_minmax(13rem,1.15fr)_minmax(13rem,1fr)_minmax(7.5rem,0.58fr)_minmax(9rem,0.72fr)_minmax(7.5rem,0.58fr)_minmax(8rem,0.62fr)]";

const METRIC_HELP = {
  deviation: "Current deviation from the peg in basis points. 100 bps equals 1%.",
  dews: "DEWS is the Depeg Early Warning Score, a 0-100 stress score. Higher is more stressed.",
  pegHealth: "Peg Health merges Peg Score, where 100 is best, with the live percent of observations holding peg.",
  events: "Confirmed depeg event count for the asset, with the worst historical deviation shown below.",
  dexCheck: "DEX check compares trusted DEX prices with the primary peg signal when available.",
};

function statusLabel(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "live";
  if (row.pendingIncident) return "pending";
  if (row.coin.depegEventCoverageLimited) return "floor";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return row.dews.band.toLowerCase();
  return "clear";
}

function statusClassName(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (row.pendingIncident) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (row.coin.depegEventCoverageLimited) return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") {
    return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function rowToneClassName(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "bg-red-500/[0.07] ring-1 ring-inset ring-red-500/15";
  if (row.pendingIncident) return "bg-amber-500/[0.06]";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return "bg-orange-500/[0.05]";
  if (row.coin.depegEventCoverageLimited) return "bg-sky-500/[0.04]";
  return "";
}

function ThreatTickerStrip({
  worstAbs,
  warningCount,
  totalRows,
  clearPct,
  worstSymbol,
}: {
  worstAbs: number;
  warningCount: number;
  totalRows: number;
  clearPct: number;
  worstSymbol?: string;
}) {
  const stressPct = totalRows > 0 ? (warningCount / totalRows) * 100 : 0;
  const cells = [
    {
      label: "Peg pressure",
      value: `${Math.round(worstAbs)} bps`,
      detail: worstSymbol ? `${worstSymbol} worst live move` : "no live outlier",
      icon: Waves,
      className: worstAbs >= 500 ? "text-red-700 dark:text-red-300" : worstAbs >= 100 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300",
    },
    {
      label: "Stress breadth",
      value: `${warningCount}/${totalRows || 0}`,
      detail: `${formatPercent(stressPct, 0)} of filtered rows`,
      icon: AlertTriangle,
      className: stressPct >= 25 ? "text-red-700 dark:text-red-300" : stressPct >= 10 ? "text-amber-700 dark:text-amber-300" : "text-sky-700 dark:text-sky-300",
    },
    {
      label: "At-peg coverage",
      value: formatPercent(clearPct, 0),
      detail: "tracked universe holding peg",
      icon: ShieldCheck,
      className: clearPct >= 95 ? "text-emerald-700 dark:text-emerald-300" : clearPct >= 85 ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300",
    },
  ] as const;

  return (
    <div className="grid gap-2 md:grid-cols-3" aria-label="Current depeg triage summary">
      {cells.map((cell) => {
        const Icon = cell.icon;
        return (
          <div key={cell.label} className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/55 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Icon className={cn("h-3.5 w-3.5 shrink-0", cell.className)} aria-hidden="true" />
              <div className="min-w-0">
                <div className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{cell.label}</div>
                <div className="truncate text-xs text-muted-foreground">{cell.detail}</div>
              </div>
            </div>
            <div className={cn("shrink-0 font-mono text-lg font-bold tabular-nums", cell.className)}>
              {cell.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function getDeviationBarWidthPercent(abs: number): number {
  if (abs <= 200) return (abs / 200) * 35;
  if (abs <= 500) return 35 + ((abs - 200) / 300) * 25;
  const severeRatio = Math.log10(Math.min(abs, 10_000) / 500) / Math.log10(10_000 / 500);
  return 60 + severeRatio * 35;
}

function DeviationBar({ bps }: { bps: number | null }) {
  if (bps === null) {
    return <div className="h-1.5 rounded-full bg-muted" aria-label="Deviation unavailable" />;
  }
  const abs = Math.abs(bps);
  const width = clampScore(getDeviationBarWidthPercent(abs));
  const barClass =
    abs >= 500
      ? "bg-red-500"
      : abs >= 200
        ? "bg-orange-500"
        : abs >= 50
          ? "bg-amber-500"
          : "bg-emerald-500";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-label={`Deviation ${bps > 0 ? "+" : ""}${bps} basis points`}>
      <div className={cn("h-full rounded-full", barClass)} style={{ width: `${Math.max(3, width)}%` }} />
    </div>
  );
}

function LinearGauge({
  value,
  max = 100,
  tone = "bg-emerald-500",
  ariaLabel,
}: {
  value: number | null | undefined;
  max?: number;
  tone?: string;
  ariaLabel: string;
}) {
  const pct = value == null ? 0 : clampScore((Math.abs(value) / max) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-label={ariaLabel}>
      <div className={cn("h-full rounded-full", tone)} style={{ width: value == null ? "0%" : `${Math.max(3, pct)}%` }} />
    </div>
  );
}

function metricTone(value: number | null | undefined, goodHigh = true): string {
  if (value == null) return "bg-muted-foreground";
  if (goodHigh) {
    if (value >= 80) return "bg-emerald-500";
    if (value >= 55) return "bg-amber-500";
    return "bg-red-500";
  }
  if (value >= 75) return "bg-red-500";
  if (value >= 36) return "bg-amber-500";
  return "bg-emerald-500";
}

function EventLoadMeter({ count, symbol }: { count: number; symbol: string }) {
  const filled = count <= 0 ? 0 : Math.max(1, Math.min(5, Math.ceil(Math.log10(count + 1))));
  return (
    <div className="flex gap-1" aria-label={`Historical depeg event load for ${symbol}: ${count}`}>
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 flex-1 rounded-[2px] border border-border/50",
            index < filled ? "border-orange-500/40 bg-orange-500" : "bg-muted/35",
          )}
        />
      ))}
    </div>
  );
}

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
      <div className="mb-1 flex items-baseline justify-between gap-2 md:hidden">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{value}</span>
      </div>
      <div className="hidden font-mono text-sm font-semibold tabular-nums text-foreground md:block">{value}</div>
      {children ? <div className="mt-1.5">{children}</div> : null}
      {subline ? <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{subline}</div> : null}
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
  const worstAbsDev = Math.abs(coin.worstDeviationBps ?? 0);
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
      <div className="pt-0.5 font-mono text-xs tabular-nums text-muted-foreground md:text-right">#{rank}</div>
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
          <span className={cn("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none", statusClassName(row))}>
            {statusLabel(row)}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{eventAge}</span>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{coin.pegCurrency}</span>
        </div>
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3 md:contents">
        <MetricCell
          className="col-span-2 md:col-span-1"
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
          subline={worstAbsDev > 0 ? `${worstAbsDev} bps max` : "no history"}
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
  stats,
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
}: DepegControlBoardProps) {
  const worstAbs = Math.max(0, ...rows.map((row) => Math.abs(row.coin.currentDeviationBps ?? 0)));
  const warningCount = rows.filter((row) => row.coin.activeDepeg || row.pendingIncident || (row.dews?.score ?? 0) >= 36).length;
  const totalRows = rows.length;
  const clearPct = stats && stats.totalTracked > 0 ? (stats.coinsAtPeg / stats.totalTracked) * 100 : 0;
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
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-foreground">Peg control board</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span><span className="font-mono font-semibold text-foreground tabular-nums">{sortedTotalRows}</span> rows</span>
          <span aria-hidden="true">/</span>
          <span><span className="font-mono font-semibold text-foreground tabular-nums">{warningCount}</span> attention</span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/35">
        <div className="border-b border-border/70 bg-muted/25 p-3">
          <ThreatTickerStrip
            worstAbs={worstAbs}
            warningCount={warningCount}
            totalRows={totalRows}
            clearPct={clearPct}
            worstSymbol={stats?.worstCurrent?.symbol}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && onPegFilterChange(v as PegCurrency | "all")}
              className="flex flex-wrap gap-1"
              aria-label="Filter by peg currency"
            >
              {PEG_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={typeFilter}
              onValueChange={(v) => v && onTypeFilterChange(v as GovernanceType | "all")}
              className="flex flex-wrap gap-1"
              aria-label="Filter by governance type"
            >
              {GOVERNANCE_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
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
                className="pharos-focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-border/70 bg-background/45 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                    "pharos-focus-ring rounded-sm border px-2.5 py-1.5 text-xs font-medium transition-colors",
                    sortKey === mode.key
                      ? "border-foreground/20 bg-foreground text-background"
                      : "border-border/70 bg-background/45 text-muted-foreground hover:text-foreground",
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
            <div className="font-mono text-xs tabular-nums text-muted-foreground">
              {rangeStart}-{rangeEnd} / {sortedTotalRows}
            </div>
          </div>
          <div className={cn(BOARD_GRID_CLASS, "hidden border-b border-border/60 bg-background/45 px-3 py-2 md:grid")}>
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
                    className="pharos-focus-ring mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border/70 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
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
                className="pharos-focus-ring rounded-sm border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                page {effectivePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={onNextPage}
                disabled={effectivePage >= totalPages - 1}
                className="pharos-focus-ring rounded-sm border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
