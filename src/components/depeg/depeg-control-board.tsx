"use client";

import { useId, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { FilterSearchInput } from "@/components/filter-search-input";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { TableCell } from "@/components/table";
import { TableExportMenu } from "@/components/table-export-menu";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { DEWSBadge } from "@/components/dews/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { compareDepegTrackerRows, type DepegTableSortKey } from "@/components/depeg/depeg-table-logic";
import { readTrackerDeviation, type DepegTrackerRow } from "@/lib/depeg-sort";
import type { CsvColumn } from "@/lib/exports/csv";
import { cn } from "@/lib/utils";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import {
  statusLabel,
  statusClassName,
  rowToneClassName,
  metricTone,
} from "@/components/depeg/depeg-board-model";
import { DeviationBar, LinearGauge, EventLoadMeter } from "@/components/depeg/depeg-board-primitives";
import type { PegCurrency } from "@shared/types/core";
import type { GovernanceType } from "@shared/types/stablecoin-taxonomy";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { GOVERNANCE_FILTER_OPTIONS, OPEN_INCIDENT_EVIDENCE_LABELS, PEG_FILTER_OPTIONS, THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { formatCompactUsdShort, formatCurrency, formatElapsedSeconds, formatTrackingSpanDays } from "@shared/lib/format";
import { formatPegOccupancy } from "@shared/lib/peg-format";
import type { ThreatBand } from "@shared/lib/classification";

export type DepegStatusFilter = "all" | "active_pending" | "dews_alert" | "at_peg";

export const DEPEG_STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: DepegStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active_pending", label: "Active/Pending" },
  { value: "dews_alert", label: "DEWS Alert+" },
  { value: "at_peg", label: "At peg" },
];

export function isDepegStatusFilter(value: string): value is DepegStatusFilter {
  return value === "all" || value === "active_pending" || value === "dews_alert" || value === "at_peg";
}

export function matchesDepegStatusFilter(row: DepegTrackerRow, filter: DepegStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active_pending") {
    return Boolean(row.coin.activeDepeg || row.pendingIncident);
  }
  if (filter === "dews_alert") {
    return row.dews != null && isThreatBand(row.dews.band) && THREAT_BAND_ORDER[row.dews.band] >= THREAT_BAND_ORDER.ALERT;
  }
  // R1/R2: an unavailable or held deviation is never classified as at peg.
  if (row.coin.activeDepeg || row.pendingIncident) return false;
  const { deviationBps } = readTrackerDeviation(row);
  if (deviationBps == null) return false;
  const threshold = row.coin.pegCurrency === "USD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
  return Math.abs(deviationBps) < threshold;
}

interface DepegControlBoardProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  pegFilter: PegCurrency | "all";
  typeFilter: GovernanceType | "all";
  statusFilter?: DepegStatusFilter;
  searchQuery: string;
  onPegFilterChange: (v: PegCurrency | "all") => void;
  onTypeFilterChange: (v: GovernanceType | "all") => void;
  onStatusFilterChange?: (v: DepegStatusFilter) => void;
  onSearchChange: (v: string) => void;
  onClearFilters: () => void;
  onRowClick: (id: string) => void;
  nowSeconds: number;
  /** Producer timestamp (Unix seconds) for export preamble provenance. */
  asOfSec?: number | null;
}

const BOARD_PAGE_SIZE = 12;

const METRIC_HELP = {
  attention: "Priority order: active depegs, awaiting confirmations, DEWS stress band, and current deviation magnitude.",
  deviation: "Current deviation from the peg in basis points. 100 bps equals 1%.",
  dews: "DEWS is the Depeg Early Warning Score, a 0-100 stress score. Higher is more stressed.",
  pegHealth: "Peg Health shows Peg Score, where 100 is best, alongside a recorded-window peg occupancy estimate. Tracking closure can leave unobserved time, so occupancy is not proof of recovery or continuous observation.",
  events: "Confirmed depeg event count for the asset, over the span Pharos has tracked it.",
  dexCheck: "DEX check compares trusted DEX prices with the primary peg signal when available.",
};

const BOARD_COLUMNS: readonly DataTableColumn<DepegTableSortKey>[] = [
  { id: "rank", label: "#", className: "w-11 text-right" },
  {
    id: "asset",
    label: "Asset",
    sortKey: "__attention",
    title: METRIC_HELP.attention,
    className: "min-w-[15rem]",
  },
  {
    id: "deviation",
    label: "Deviation",
    sortKey: "currentDeviationBps",
    title: METRIC_HELP.deviation,
    className: "min-w-[11rem]",
  },
  {
    id: "dews",
    label: "DEWS",
    sortKey: "dewsScore",
    title: METRIC_HELP.dews,
    className: "w-28",
  },
  {
    id: "pegHealth",
    label: "Peg health",
    sortKey: "pegScore",
    title: METRIC_HELP.pegHealth,
    className: "min-w-[10.5rem]",
  },
  {
    id: "events",
    label: "Events",
    sortKey: "eventCount",
    title: METRIC_HELP.events,
    className: "w-28",
  },
  {
    id: "dexCheck",
    label: "DEX check",
    sortKey: "dexAgrees",
    title: METRIC_HELP.dexCheck,
    className: "hidden min-w-[9.5rem] xl:table-cell",
  },
];

const DEPEG_EXPORT_COLUMNS: CsvColumn<DepegTrackerRow>[] = [
  { header: "Rank", accessor: (_row, index) => index + 1 },
  { header: "Symbol", accessor: (row) => row.coin.symbol },
  { header: "Name", accessor: (row) => row.coin.name },
  { header: "Peg", accessor: (row) => row.coin.pegCurrency },
  { header: "Status", accessor: (row) => statusLabel(row) },
  { header: "Current Deviation (bps)", accessor: (row) => readTrackerDeviation(row).deviationBps },
  { header: "Worst Deviation (bps)", accessor: (row) => row.coin.worstDeviationBps },
  { header: "DEWS Score", accessor: (row) => row.dews?.score ?? null },
  { header: "DEWS Band", accessor: (row) => row.dews?.band ?? null },
  { header: "Peg Score", accessor: (row) => row.coin.pegScore },
  { header: "At Peg (%)", accessor: (row) => row.coin.pegPct },
  { header: "Events", accessor: (row) => row.coin.eventCount },
  { header: "Market Cap (USD)", accessor: (row) => row.marketCapUsd ?? null },
  {
    header: "DEX Check",
    accessor: (row) =>
      row.coin.dexPriceCheck ? (row.coin.dexPriceCheck.agrees ? "agree" : "diverge") : null,
  },
];

function InstrumentTableRow({
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
  const occupancyBasisId = useId();
  const coin = row.coin;
  const { deviationBps, referenceNote } = readTrackerDeviation(row);
  const deviationClass = deviationBps == null
    ? "text-muted-foreground"
    : deviationColorClass(Math.abs(deviationBps));
  const trackingSpan = formatTrackingSpanDays(coin.trackingSpanDays);
  const pegHealthValue =
    coin.pegScore !== null ? (
      <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span>
    ) : (
      // A score withheld for want of a usable price names that reason.
      <span className="text-muted-foreground" title={coin.currentPriceUnavailable ? "No usable price" : undefined}>
        NR{coin.currentPriceUnavailable ? <span className="sr-only">, no usable price</span> : null}
      </span>
    );
  // The response's pending ageSec is request-frozen; derive from firstSeenAt
  // so the row follows the same display clock as the last-event age.
  const eventAge = row.pendingIncident
    ? formatElapsedSeconds(Math.max(0, nowSeconds - row.pendingIncident.firstSeenAt))
    : coin.lastEventAt != null
      ? `${formatElapsedSeconds(Math.max(0, nowSeconds - coin.lastEventAt))} ago`
      : "clear";

  return (
    <InteractiveTableRow
      onActivate={() => onRowClick(coin.id)}
      onHover={() => prefetch(coin.id)}
      className={cn("align-middle", rowToneClassName(row))}
    >
      <TableCell className="pharos-numeric text-right text-xs text-muted-foreground">
        #{rank}
      </TableCell>
      <TableCell className="min-w-0">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRowClick(coin.id);
          }}
          aria-label={`Open ${coin.symbol} depeg detail`}
          aria-describedby={occupancyBasisId}
          className="pharos-focus-ring block w-full rounded-sm text-left"
        >
          <StablecoinIdentity
            logoSrc={logos?.[coin.id]}
            name={coin.name}
            symbol={coin.symbol}
            logoSize={22}
            symbolClassName="text-sm font-semibold"
            badge={<span className="hidden truncate text-xs text-muted-foreground sm:inline">{coin.name}</span>}
          />
        </button>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={cn("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-semibold uppercase leading-none", statusClassName(row))}>
            {statusLabel(row)}
          </span>
          {coin.activeDepeg ? (
            <span className="pharos-meta">{OPEN_INCIDENT_EVIDENCE_LABELS[row.openIncidentEvidence ?? "unconfirmed"]}</span>
          ) : null}
          <span className="pharos-meta pharos-numeric">{eventAge}</span>
          <span className="pharos-meta pharos-numeric">{coin.pegCurrency}</span>
          {row.marketCapUsd !== undefined ? (
            <span className="pharos-meta pharos-numeric">
              {row.marketCapUsd == null ? "cap unavailable" : `${formatCompactUsdShort(row.marketCapUsd)} cap`}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="pharos-numeric text-sm font-semibold text-foreground">
          <span className={cn(deviationClass)}>
            {referenceNote ?? (deviationBps != null ? `${deviationBps > 0 ? "+" : ""}${deviationBps} bps` : "—")}
          </span>
        </div>
        <div className="mt-1.5">
          <DeviationBar bps={deviationBps} />
        </div>
        <div className="pharos-meta pharos-numeric mt-1 truncate">
          {coin.worstDeviationBps != null ? `worst ${coin.worstDeviationBps > 0 ? "+" : ""}${coin.worstDeviationBps} bps` : "worst —"}
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="pharos-numeric text-sm font-semibold text-foreground">
          {row.dews ? row.dews.score : "—"}
        </div>
        <div className="mt-1.5 flex min-h-5 items-center gap-2">
          {row.dews ? (
            <DEWSBadge score={row.dews.score} band={row.dews.band as ThreatBand} compact signals={row.dews.signals} />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
        <div className="pharos-meta pharos-numeric mt-1 truncate">
          {row.dews?.band ? `${row.dews.band.toLowerCase()} band` : "no signal"}
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="pharos-numeric text-sm font-semibold text-foreground">{pegHealthValue}</div>
        <div className="mt-1.5">
          <LinearGauge value={coin.pegScore} tone={metricTone(coin.pegScore)} ariaLabel={`Peg score for ${coin.symbol}`} />
        </div>
        {/* Concise visible subline; full occupancy caveat lives in title, column help, and sr-only description. */}
        <p
          id={occupancyBasisId}
          className="mt-1 text-xs text-muted-foreground"
          title="Recorded-window peg occupancy estimate. Tracking closure can leave unobserved time; this is not proof of recovery or continuous observation."
        >
          <span className="font-mono">{formatPegOccupancy(coin.pegPct, 1)}</span> at peg
          <span className="sr-only">
            {" "}recorded-window peg occupancy estimate. Tracking closure can leave unobserved time; this is not proof of recovery or continuous observation.
          </span>
        </p>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="pharos-numeric text-sm font-semibold text-foreground">{coin.eventCount}</div>
        <div className="mt-1.5">
          <EventLoadMeter count={coin.eventCount} symbol={coin.symbol} />
        </div>
        <div className="pharos-meta pharos-numeric mt-1 truncate">
          {coin.eventCount > 0 ? `over ${trackingSpan}` : "no history"}
        </div>
      </TableCell>
      <TableCell className="hidden min-w-0 xl:table-cell">
        <div className="pharos-numeric text-sm font-semibold text-foreground">
          {coin.dexPriceCheck ? (coin.dexPriceCheck.agrees ? "agree" : "diverge") : "—"}
        </div>
        <div className="pharos-meta pharos-numeric mt-1 truncate">
          {coin.dexPriceCheck
            ? `${coin.dexPriceCheck.sourcePools} price ${coin.dexPriceCheck.sourcePools === 1 ? "source" : "sources"} · ${formatCurrency(coin.dexPriceCheck.sourceTvl)}`
            : formatTrackingSpanDays(coin.trackingSpanDays)}
        </div>
      </TableCell>
    </InteractiveTableRow>
  );
}

export function DepegControlBoard({
  rows,
  logos,
  pegFilter,
  typeFilter,
  statusFilter,
  searchQuery,
  onPegFilterChange,
  onTypeFilterChange,
  onStatusFilterChange,
  onSearchChange,
  onClearFilters,
  onRowClick,
  nowSeconds,
  asOfSec = null,
}: DepegControlBoardProps) {
  const [uncontrolledStatus, setUncontrolledStatus] = useState<DepegStatusFilter>("all");
  const activeStatusFilter = statusFilter ?? uncontrolledStatus;
  const handleStatusChange = (next: DepegStatusFilter) => {
    if (onStatusFilterChange) {
      onStatusFilterChange(next);
    } else {
      setUncontrolledStatus(next);
    }
  };
  const handleClearAll = () => {
    if (!onStatusFilterChange) {
      setUncontrolledStatus("all");
    }
    onClearFilters();
  };

  const statusFilteredRows = useMemo(
    () => rows.filter((row) => matchesDepegStatusFilter(row, activeStatusFilter)),
    [rows, activeStatusFilter],
  );

  const warningCount = statusFilteredRows.filter((row) => row.coin.activeDepeg || row.pendingIncident ||
    (row.dews != null && isThreatBand(row.dews.band) && THREAT_BAND_ORDER[row.dews.band] >= THREAT_BAND_ORDER.ALERT)).length;
  // Below the live-event supply floor, event history is not scored. Count only
  // the rows in view so this figure shares the attention count's universe.
  const eventFloorCount = statusFilteredRows.filter((row) => row.coin.depegEventCoverageLimited).length;
  const filtersActive =
    pegFilter !== "all" || typeFilter !== "all" || activeStatusFilter !== "all" || searchQuery.length > 0;

  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    sortedRows,
    effectivePage,
    totalPages,
    paginatedRows,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows: sortedTotalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<DepegTrackerRow, DepegTableSortKey>(statusFilteredRows, {
    defaultKey: "__attention",
    defaultDirection: "desc",
    compareRows: compareDepegTrackerRows,
    pageSize: BOARD_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });

  const exportAsOfISO =
    asOfSec != null && Number.isFinite(asOfSec) && asOfSec > 0
      ? new Date(asOfSec * 1000).toISOString()
      : "unknown";

  const toolbar = (
    <div className="pharos-table-toolbar space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ControlPillToggle
          variant="segmented"
          options={DEPEG_STATUS_FILTER_OPTIONS}
          value={activeStatusFilter}
          onChange={handleStatusChange}
          ariaLabel="Filter by peg status"
          buttonClassName="min-h-11 sm:min-h-8"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="pharos-numeric text-xs text-muted-foreground">
            {sortedTotalRows > 0 ? `${rangeStart}-${rangeEnd} / ${sortedTotalRows}` : "0 / 0"}
          </span>
          <TableExportMenu
            data={sortedRows}
            columns={DEPEG_EXPORT_COLUMNS}
            filename="pharos-depeg-board"
            asOfISO={exportAsOfISO}
            endpoint="peg-summary"
            methodologyLabel={`depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`}
            disabled={sortedRows.length === 0}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ControlPillToggle
          options={PEG_FILTER_OPTIONS}
          value={pegFilter}
          onChange={onPegFilterChange}
          ariaLabel="Filter by peg currency"
          className="flex flex-wrap gap-1"
        />
        <ControlPillToggle
          options={GOVERNANCE_FILTER_OPTIONS}
          value={typeFilter}
          onChange={onTypeFilterChange}
          ariaLabel="Filter by governance type"
          className="flex flex-wrap gap-1"
        />
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
            onClick={handleClearAll}
            className="pharos-focus-ring pharos-control-pill gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <section id="data" aria-label="Depeg control board" tabIndex={-1} className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="pharos-label">Leaderboard controls</p>
          <h2 className="pharos-section-title mt-1">Peg control board</h2>
        </div>
        <p className="pharos-meta">
          <span className="pharos-numeric font-semibold text-foreground">
            {warningCount}
          </span>{" "}
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

      <DataTableShell
        tableId="depeg-control-board"
        columns={BOARD_COLUMNS}
        sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
        stickyHeader
        stickyMode="page"
        topSlot={toolbar}
        tableClassName="min-w-[780px]"
        pagination={
          totalPages > 1
            ? {
                page: effectivePage,
                totalPages,
                rangeStart,
                rangeEnd,
                total: sortedTotalRows,
                onPrevious: onPreviousPage,
                onNext: onNextPage,
                noun: "coins",
              }
            : undefined
        }
      >
        {paginatedRows.length === 0 ? (
          <DataTableEmptyRow colSpan={BOARD_COLUMNS.length}>
            <p className="text-sm text-muted-foreground">No stablecoins match these filters.</p>
            {filtersActive ? (
              <button
                type="button"
                onClick={handleClearAll}
                className="pharos-focus-ring pharos-control-pill mt-3 gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Clear filters
              </button>
            ) : null}
          </DataTableEmptyRow>
        ) : (
          paginatedRows.map((row, index) => (
            <InstrumentTableRow
              key={row.coin.id}
              row={row}
              rank={pageStartIndex + index + 1}
              logos={logos}
              onRowClick={onRowClick}
              nowSeconds={nowSeconds}
            />
          ))
        )}
      </DataTableShell>
    </section>
  );
}
