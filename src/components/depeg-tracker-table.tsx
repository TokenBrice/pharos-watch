"use client";

import { useState } from "react";
import {
  TableCell,
} from "@/components/table";
import {
  DataTableEmptyRow,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { DEWSBadge } from "@/components/dews-badge";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { type DepegTrackerRow } from "@/lib/depeg-sort";
import { getDewsAmplifiers, getDewsFreshness, getTopDewsContributors } from "@/lib/dews-signal-utils";
import { CRON_30MIN } from "@/lib/cron-intervals";
import type { ThreatBand } from "@shared/lib/classification";
import { formatPercent, formatTrackingSpanDays } from "@shared/lib/format";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import {
  compareDepegTrackerRows,
  rowAccentClass,
  type DepegTableSortKey,
} from "@/components/depeg-table-logic";
import { MethodologyHint } from "@/components/methodology-hint";
import type { QueryKey } from "@tanstack/react-query";

export type { DepegTrackerRow } from "@/lib/depeg-sort";

// M1: the depeg tracker rows derive from peg-summary + stress-signals; surface
// a RefreshingBar while either refetches in the background.
const DEPEG_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  ["peg-summary"],
  ["stress-signals"],
];

interface DepegTrackerTableProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

const DEPEG_TRACKER_COLUMNS: readonly DataTableColumn<DepegTableSortKey>[] = [
  { id: "rank", label: <span aria-label="Rank">#</span>, className: "w-[50px] text-right" },
  { id: "name", label: "Name", className: "w-[64px] sm:w-[70px] xl:w-[200px] max-w-[64px] sm:max-w-[70px] xl:max-w-none" },
  { id: "status", label: "Status", className: "text-left" },
  { id: "pegScore", label: "Peg Score", headerAdornment: <MethodologyHint topic="pegScore" />, sortKey: "pegScore", className: "text-right" },
  { id: "dewsScore", label: "DEWS", headerAdornment: <MethodologyHint topic="dews" />, sortKey: "dewsScore", className: "text-right hidden sm:table-cell" },
  { id: "currentDeviationBps", label: "Deviation", sortKey: "currentDeviationBps", className: "text-right" },
  { id: "pegPct", label: "Peg %", sortKey: "pegPct", className: "text-right hidden md:table-cell" },
  { id: "eventCount", label: "Incidents", sortKey: "eventCount", className: "text-right hidden md:table-cell" },
  { id: "worstDeviationBps", label: "Worst", sortKey: "worstDeviationBps", className: "text-right hidden lg:table-cell" },
  { id: "dexAgrees", label: "DEX Cross-check", sortKey: "dexAgrees", className: "text-center hidden xl:table-cell" },
  { id: "trackingSpanDays", label: "Tracking", sortKey: "trackingSpanDays", className: "text-right hidden xl:table-cell" },
  { id: "peg30d", label: "90d Peg", className: "text-right w-[112px] hidden xl:table-cell" },
] as const;

const DEWS_STALE_AFTER_SECONDS = CRON_30MIN / 1000;

function StatusBadge({ row }: { row: DepegTrackerRow }) {
  if (row.coin.activeDepeg) {
    return (
      <span className="inline-flex items-center rounded-sm border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-red-700 dark:text-red-400">
        LIVE
      </span>
    );
  }
  if (row.pendingIncident) {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-700 dark:text-amber-300"
        title="Awaiting secondary-source confirmation."
      >
        Pending
      </span>
    );
  }
  if (row.coin.depegEventCoverageLimited) {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-sky-700 dark:text-sky-300"
        title="Below the live depeg-event floor; price deviation is shown without opening live events."
      >
        Coverage-limited
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}

export function DepegTrackerTable({ rows, logos, onRowClick }: DepegTrackerTableProps) {
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<DepegTrackerRow, DepegTableSortKey>(
    rows,
    {
      defaultKey: "__attention",
      defaultDirection: "desc",
      compareRows: compareDepegTrackerRows,
      pageSize: TABLE_PAGE_SIZE,
    },
  );
  const prefetch = usePrefetchStablecoin();

  return (
    <DataTableShell
      tableId="depeg-tracker"
      testId="depeg-tracker-table"
      columns={DEPEG_TRACKER_COLUMNS}
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
      }}
      striped
      tableClassName="min-w-[360px] sm:min-w-[420px] table-fixed"
      refreshingQueryKeys={DEPEG_REFRESH_QUERY_KEYS}
      pagination={{
        page: effectivePage,
        totalPages,
        rangeStart,
        rangeEnd,
        total: totalRows,
        onPrevious: onPreviousPage,
        onNext: onNextPage,
        noun: "stablecoins",
      }}
    >
      {paginated.map((row, i) => {
            const coin = row.coin;
            const dews = row.dews;
            const absDev = Math.abs(coin.currentDeviationBps ?? 0);
            const accent = rowAccentClass(row);
            const rank = pageStartIndex + i + 1;
            const provenanceLabel = [coin.priceSource ?? "unknown source", coin.priceConfidence ?? "unknown confidence"].join(" · ");
            const trustBadge =
              coin.primaryTrust === "confirm_required"
                ? coin.priceSource === "cached"
                  ? "cached"
                  : coin.priceConfidence === "low"
                    ? "low conf"
                    : "verify"
                : null;

            return (
              <InteractiveTableRow
                key={coin.id}
                className={`h-11 hover:bg-muted/50 transition-colors ${accent}`}
                onActivate={() => onRowClick(coin.id)}
                onHover={() => prefetch(coin.id)}
                role="link"
                ariaLabel={`Open ${coin.symbol} depeg detail`}
              >
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground text-sm">
                  {rank}
                </TableCell>
                <TableCell>
                  <StablecoinIdentity
                    className="min-w-0"
                    logoSrc={logos?.[coin.id]}
                    name={coin.name}
                    symbol={coin.symbol}
                    logoSize={20}
                    symbolClassName="text-sm truncate"
                    badge={
                      <>
                        {trustBadge && (
                          <span
                            className="hidden shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline-flex"
                            title={`Primary price requires confirmation (${provenanceLabel})`}
                            aria-label={`Primary price requires confirmation (${provenanceLabel})`}
                          >
                            {trustBadge}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground truncate hidden xl:inline">{coin.name}</span>
                      </>
                    }
                  />
                </TableCell>
                <TableCell>
                  <StatusBadge row={row} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {coin.pegScore !== null ? (
                    <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span>
                  ) : (
                    <span className="text-muted-foreground">NR</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden sm:table-cell">
                  {dews ? (
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center justify-end gap-1.5">
                      <DEWSBadge score={dews.score} band={dews.band as ThreatBand} signals={dews.signals} />
                      <span className="text-xs font-mono tabular-nums text-muted-foreground w-5 text-right">
                        {dews.score}
                      </span>
                      </div>
                      {(() => {
                        const top = getTopDewsContributors(dews.signals, 2);
                        const amplifiers = getDewsAmplifiers(dews);
                        const freshness = getDewsFreshness(dews.computedAt, nowSeconds, DEWS_STALE_AFTER_SECONDS);
                        return (
                          <div className="max-w-[160px] truncate text-[10px] text-muted-foreground">
                            {top.length > 0 ? top.map((item) => item.shortLabel).join(", ") : "no active drivers"}
                            {amplifiers.length > 0 ? ` · ${amplifiers.map((amp) => `${amp.label} ${amp.value.toFixed(2)}x`).join(", ")}` : ""}
                            {freshness.label ? ` · ${freshness.stale ? "stale " : ""}${freshness.label}` : ""}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm" title={provenanceLabel}>
                  {coin.currentDeviationBps !== null ? (
                    <span className={deviationColorClass(absDev)}>
                      {coin.currentDeviationBps > 0 ? "+" : ""}{coin.currentDeviationBps} bps
                    </span>
                  ) : coin.pegReferenceUnavailable ? (
                    <span
                      className="text-muted-foreground"
                      title="Peg reference unavailable: the FX reference is offline and this coin's peer group is too thin to verify deviation."
                    >
                      ref n/a
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {formatPercent(coin.pegPct, 1)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {coin.eventCount}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden lg:table-cell">
                  {coin.worstDeviationBps !== null ? (
                    <span className={deviationColorClass(Math.abs(coin.worstDeviationBps))}>
                      {coin.worstDeviationBps > 0 ? "+" : ""}{coin.worstDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-center hidden xl:table-cell">
                  {coin.dexPriceCheck ? (
                    coin.dexPriceCheck.agrees ? (
                      <span className="text-emerald-700 dark:text-emerald-400 text-sm" title="DEX price agrees" aria-label="DEX price agrees">&#10003;</span>
                    ) : (
                      <span className="text-destructive text-sm" title="DEX price disagrees" aria-label="DEX price disagrees">&#10007;</span>
                    )
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden xl:table-cell">
                  {formatTrackingSpanDays(coin.trackingSpanDays)}
                </TableCell>
                <TableCell
                  data-column-id="peg30d"
                  className="text-right w-[112px] hidden xl:table-cell"
                >
                  {coin.recent90d ? (
                    <span
                      className="font-mono text-sm tabular-nums"
                      title={`${coin.recent90d.incidentCount} incidents, ${coin.recent90d.thresholdCrossingCount} threshold crossings across ${Math.floor(coin.recent90d.observedDays)} observed days${coin.recent90d.coverageLimited ? " (partial coverage)" : ""}`}
                    >
                      {formatPercent(coin.recent90d.pegPct, 1)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </InteractiveTableRow>
            );
      })}
      {paginated.length === 0 && (
        <DataTableEmptyRow colSpan={DEPEG_TRACKER_COLUMNS.length}>
          No stablecoins match these filters.
        </DataTableEmptyRow>
      )}
    </DataTableShell>
  );
}
