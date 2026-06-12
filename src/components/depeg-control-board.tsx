"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Gauge, ShieldCheck } from "lucide-react";
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
  "grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[2.5rem_minmax(11rem,1.12fr)_minmax(12rem,1fr)_minmax(7rem,0.58fr)_minmax(7rem,0.58fr)_minmax(7rem,0.58fr)] xl:grid-cols-[2.75rem_minmax(13rem,1.15fr)_minmax(13rem,1fr)_minmax(7.5rem,0.58fr)_minmax(7.5rem,0.58fr)_minmax(7.5rem,0.58fr)_minmax(7.5rem,0.58fr)_minmax(8rem,0.62fr)]";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

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
  if (row.coin.activeDepeg) return "border-l-red-500/70 bg-red-500/[0.018]";
  if (row.pendingIncident) return "border-l-amber-500/70 bg-amber-500/[0.02]";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return "border-l-orange-500/70 bg-orange-500/[0.016]";
  if (row.coin.depegEventCoverageLimited) return "border-l-sky-500/60";
  return "border-l-emerald-500/50";
}

function gaugeToneClassName(tone: "green" | "amber" | "red" | "blue"): string {
  switch (tone) {
    case "red":
      return "text-red-600 dark:text-red-400";
    case "amber":
      return "text-amber-600 dark:text-amber-300";
    case "blue":
      return "text-sky-600 dark:text-sky-300";
    case "green":
    default:
      return "text-emerald-600 dark:text-emerald-300";
  }
}

function SemicircleGauge({
  value,
  tone,
  label,
}: {
  value: number;
  tone: "green" | "amber" | "red" | "blue";
  label: string;
}) {
  const progress = clampPercent(value);
  const dash = 126;
  const offset = dash - (dash * progress) / 100;
  return (
    <svg viewBox="0 0 120 68" role="img" aria-label={`${label}: ${Math.round(progress)} percent`} className="h-12 w-20">
      <path
        d="M18 58a42 42 0 0 1 84 0"
        fill="none"
        stroke="var(--color-border)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M18 58a42 42 0 0 1 84 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={dash}
        strokeDashoffset={offset}
        className={gaugeToneClassName(tone)}
      />
      <line x1="60" y1="58" x2={60 + Math.cos(Math.PI - (Math.PI * progress) / 100) * 32} y2={58 - Math.sin(Math.PI - (Math.PI * progress) / 100) * 32} stroke="var(--color-foreground)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="58" r="3" fill="var(--color-foreground)" />
    </svg>
  );
}

function BoardGauge({
  icon: Icon,
  label,
  value,
  subvalue,
  progress,
  tone,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  subvalue: string;
  progress: number;
  tone: "green" | "amber" | "red" | "blue";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </div>
          <div className="mt-1.5 font-mono text-xl font-bold leading-none tabular-nums text-foreground">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{subvalue}</div>
        </div>
        <SemicircleGauge value={progress} tone={tone} label={label} />
      </div>
    </div>
  );
}

function DeviationBar({ bps }: { bps: number | null }) {
  if (bps === null) {
    return <div className="h-1.5 rounded-full bg-muted" aria-label="Deviation unavailable" />;
  }
  const abs = Math.abs(bps);
  const width = clampPercent((abs / 500) * 100);
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
  const pct = value == null ? 0 : clampPercent((Math.abs(value) / max) * 100);
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

function desktopHeaderCell(label: string, className?: string) {
  return (
    <div className={cn("text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground", className)}>
      {label}
    </div>
  );
}

function MetricCell({
  label,
  value,
  children,
  subline,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
  subline?: ReactNode;
}) {
  return (
    <div className="col-span-2 min-w-0 md:col-span-1">
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
        "items-center border-l-2 border-b border-border/55 px-3 py-2.5 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
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
      <div className="col-span-2 md:col-span-1">
        <MetricCell
          label="Deviation"
          value={(
            <span className={cn(deviationColorClass(absDev))}>
            {coin.currentDeviationBps != null ? `${coin.currentDeviationBps > 0 ? "+" : ""}${coin.currentDeviationBps} bps` : "—"}
            </span>
          )}
          subline={coin.worstDeviationBps != null ? `worst ${coin.worstDeviationBps > 0 ? "+" : ""}${coin.worstDeviationBps}` : "worst —"}
        >
          <DeviationBar bps={coin.currentDeviationBps} />
        </MetricCell>
      </div>
      <MetricCell
        label="DEWS"
        value={row.dews ? row.dews.score : "—"}
        subline={row.dews?.band ? row.dews.band.toLowerCase() : "no signal"}
      >
        <div className="flex items-center gap-2">
          {row.dews ? (
            <>
              <DEWSBadge score={row.dews.score} band={row.dews.band as ThreatBand} compact signals={row.dews.signals} />
              <LinearGauge value={row.dews.score} tone={metricTone(row.dews.score, false)} ariaLabel={`DEWS score for ${coin.symbol}`} />
            </>
          ) : (
            <LinearGauge value={null} ariaLabel={`DEWS score for ${coin.symbol}`} />
          )}
        </div>
      </MetricCell>
      <MetricCell
        label="Peg score"
        value={coin.pegScore !== null ? <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span> : <span className="text-muted-foreground">NR</span>}
        subline={formatPercent(coin.pegPct, 1)}
      >
        <LinearGauge value={coin.pegScore} tone={metricTone(coin.pegScore)} ariaLabel={`Peg score for ${coin.symbol}`} />
      </MetricCell>
      <MetricCell
        label="Events"
        value={coin.eventCount}
        subline={worstAbsDev > 0 ? `${worstAbsDev} bps max` : "no history"}
      >
        <LinearGauge value={coin.eventCount} max={2000} tone={coin.eventCount > 0 ? "bg-orange-500" : "bg-emerald-500"} ariaLabel={`Historical depeg events for ${coin.symbol}`} />
      </MetricCell>
      <div className="hidden items-center justify-between gap-2 xl:block">
        <MetricCell label="Peg %" value={formatPercent(coin.pegPct, 1)} subline={formatTrackingSpanDays(coin.trackingSpanDays)}>
          <LinearGauge value={coin.pegPct} tone={metricTone(coin.pegPct)} ariaLabel={`Peg percent for ${coin.symbol}`} />
        </MetricCell>
      </div>
      <div className="hidden xl:block">
        <MetricCell
          label="Cross-check"
          value={coin.dexPriceCheck ? (coin.dexPriceCheck.agrees ? "agree" : "diverge") : "—"}
          subline={coin.dexPriceCheck ? `${coin.dexPriceCheck.sourcePools} pools · ${formatCurrency(coin.dexPriceCheck.sourceTvl)}` : formatTrackingSpanDays(coin.trackingSpanDays)}
        />
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
  onRowClick,
  nowSeconds,
}: DepegControlBoardProps) {
  const worstAbs = Math.max(0, ...rows.map((row) => Math.abs(row.coin.currentDeviationBps ?? 0)));
  const warningCount = rows.filter((row) => row.coin.activeDepeg || row.pendingIncident || (row.dews?.score ?? 0) >= 36).length;
  const totalRows = rows.length;
  const clearPct = stats && stats.totalTracked > 0 ? (stats.coinsAtPeg / stats.totalTracked) * 100 : 0;
  const stressPct = totalRows > 0 ? (warningCount / totalRows) * 100 : 0;
  const pressureTone = worstAbs >= 500 ? "red" : worstAbs >= 100 ? "amber" : "green";
  const stressTone = stressPct >= 25 ? "red" : stressPct >= 10 ? "amber" : "blue";
  const clearTone = clearPct >= 95 ? "green" : clearPct >= 85 ? "amber" : "red";

  const {
    sortKey,
    toggleSort,
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
          <div className="grid gap-3 lg:grid-cols-3">
            <BoardGauge
              icon={Gauge}
              label="Peg pressure"
              value={`${Math.round(worstAbs)} bps`}
              subvalue={stats?.worstCurrent ? `${stats.worstCurrent.symbol} worst live move` : "no live outlier"}
              progress={(worstAbs / 500) * 100}
              tone={pressureTone}
            />
            <BoardGauge
              icon={AlertTriangle}
              label="Stress breadth"
              value={formatPercent(stressPct, 0)}
              subvalue={`${warningCount} of ${totalRows || 0} filtered rows`}
              progress={stressPct}
              tone={stressTone}
            />
            <BoardGauge
              icon={ShieldCheck}
              label="At-peg coverage"
              value={stats ? formatPercent(clearPct, 0) : "—"}
              subvalue={stats ? `${stats.coinsAtPeg} of ${stats.totalTracked} monitored` : "summary unavailable"}
              progress={clearPct}
              tone={clearTone}
            />
          </div>
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
                    aria-pressed={sortKey === mode.key}
                    className={cn(
                      "pharos-focus-ring rounded-sm border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      sortKey === mode.key
                        ? "border-foreground/20 bg-foreground text-background"
                        : "border-border/70 bg-background/45 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode.label}
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
              {desktopHeaderCell("Deviation")}
              {desktopHeaderCell("DEWS")}
              {desktopHeaderCell("Peg score")}
              {desktopHeaderCell("Events")}
              {desktopHeaderCell("Peg %", "hidden xl:block")}
              {desktopHeaderCell("Cross-check", "hidden xl:block")}
            </div>
            <div className="divide-y divide-border/55">
              {paginatedRows.length === 0 ? (
                <div className="px-3 py-12 text-center text-sm text-muted-foreground">No stablecoins match these filters.</div>
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
                  disabled={effectivePage <= 1}
                  className="pharos-focus-ring rounded-sm border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  page {effectivePage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={onNextPage}
                  disabled={effectivePage >= totalPages}
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
