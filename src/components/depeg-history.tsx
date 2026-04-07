"use client";

import { useMemo } from "react";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useTablePagination } from "@/hooks/use-table-pagination";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { formatDuration, formatNativePrice, formatEventDate, formatBps, formatCurrency } from "@shared/lib/format";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-detection-config";
import { deviationColorClass } from "@/lib/severity-colors";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { computePegStability } from "@/lib/peg-stability";
import type { DepegEvent } from "@shared/types";

function sortEvents(events: DepegEvent[]): DepegEvent[] {
  return [...events].sort((a, b) => {
    // Ongoing events first
    if (!a.endedAt && b.endedAt) return -1;
    if (a.endedAt && !b.endedAt) return 1;
    // Then by start date descending
    return b.startedAt - a.startedAt;
  });
}

const DEPEG_HISTORY_PAGE_SIZE = 25;
const EMPTY_EVENTS: DepegEvent[] = [];
const DEPEG_HISTORY_DESCRIPTION =
  "Recorded depeg detections for this stablecoin, sorted newest first. Peg score uses a rolling 4-year window.";
const DEPEG_HISTORY_COLUMNS: readonly DataTableColumn[] = [
  { id: "date", label: "Date" },
  { id: "direction", label: "Direction" },
  { id: "peakDeviation", label: "Peak Deviation", className: "text-right" },
  { id: "duration", label: "Duration", className: "text-right" },
  { id: "startPrice", label: "Start Price", className: "hidden lg:table-cell text-right" },
  { id: "peakPrice", label: "Peak Price", className: "hidden lg:table-cell text-right" },
  { id: "recoveryPrice", label: "Recovery Price", className: "hidden lg:table-cell text-right" },
] as const;

function DepegHistoryIntro() {
  return (
    <div className="mb-3">
      <h2 className={DETAIL_SECTION_TITLE_CLASS}>Depeg History</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {DEPEG_HISTORY_DESCRIPTION}
      </p>
    </div>
  );
}

export function DepegHistory({
  stablecoinId,
  earliestTrackingDate,
  hasPriceData = true,
  depegEventCoverageLimited = false,
}: {
  stablecoinId: string;
  earliestTrackingDate?: number | null;
  hasPriceData?: boolean;
  depegEventCoverageLimited?: boolean;
}) {
  const {
    data,
    isLoading,
    error,
    refetch,
    isFetchingNextPage,
    loadedCount,
    isFullyLoaded,
  } = useInfiniteDepegEvents({ stablecoinId });
  const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
  const pegCurrency = meta?.flags.pegCurrency ?? "USD";
  const events = data?.events ?? EMPTY_EVENTS;
  const totalEvents = data?.total ?? events.length;
  const sorted = useMemo(() => sortEvents(events), [events]);
  const metrics = isFullyLoaded
    ? computePegStability(sorted, earliestTrackingDate ?? null)
    : null;
  const worstDeviationBps = metrics?.worstDeviationBps ?? null;
  const {
    effectivePage,
    totalPages,
    paginatedRows,
    rangeStart,
    rangeEnd,
    onPreviousPage,
    onNextPage,
  } = useTablePagination(sorted, { pageSize: DEPEG_HISTORY_PAGE_SIZE });
  const isHydratingFullHistory = totalEvents > loadedCount;

  if (isLoading) {
    return (
      <Card className="p-4">
        <DepegHistoryIntro />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (error && !(data?.events?.length)) {
    return (
      <Card className="p-4">
        <DepegHistoryIntro />
        <QueryErrorNotice error={error} onRetry={() => void refetch()} />
      </Card>
    );
  }

  if (!error && events.length === 0) {
    const noData = !hasPriceData;
    return (
      <Card className="p-4">
        <DepegHistoryIntro />
        {noData ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              No depeg events recorded. No price data available to verify peg status.
            </p>
          </div>
        ) : depegEventCoverageLimited ? (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              No depeg events recorded. This coin is currently below the {formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live depeg-event floor, so Pharos shows the price deviation but does not open live depeg events at this size.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              No depeg events recorded. This stablecoin has maintained its peg.
            </p>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <DepegHistoryIntro />
      {error ? (
        <div className="mb-4">
          <QueryErrorNotice error={error} hasData onRetry={() => void refetch()} />
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-muted-foreground">Events </span>
          <span className="font-mono font-semibold">{totalEvents.toLocaleString()}</span>
        </div>
        {worstDeviationBps != null && (
          <div>
            <span className="text-muted-foreground">Worst Depeg </span>
            <span className={`font-mono font-semibold ${deviationColorClass(Math.abs(worstDeviationBps))}`}>
              {formatBps(worstDeviationBps)}
            </span>
          </div>
        )}
        {metrics ? (
          <div>
            <span className="text-muted-foreground">Current Streak </span>
            {metrics.depeggedNow ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
                Depegged now
              </span>
            ) : metrics.currentStreakDays !== null ? (
              <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">{metrics.currentStreakDays}d at peg</span>
            ) : (
              <span className="font-mono font-semibold text-muted-foreground">—</span>
            )}
          </div>
        ) : null}
      </div>
      {isHydratingFullHistory ? (
        <p className="mb-3 text-xs text-muted-foreground">
          Loading full history... {loadedCount.toLocaleString()} / {totalEvents.toLocaleString()} events
          {isFetchingNextPage ? "" : " loaded"}
        </p>
      ) : null}
      <DataTableShell
        columns={DEPEG_HISTORY_COLUMNS}
        containerClassName="rounded-xl border overflow-hidden"
        tableClassName="min-w-[420px]"
        pagination={isFullyLoaded && totalEvents > 0 ? {
          page: effectivePage,
          totalPages,
          rangeStart,
          rangeEnd,
          total: totalEvents,
          onPrevious: onPreviousPage,
          onNext: onNextPage,
          noun: "events",
        } : undefined}
      >
        {paginatedRows.map((event) => (
          <DepegRow key={event.id} event={event} pegCurrency={pegCurrency} />
        ))}
      </DataTableShell>
    </Card>
  );
}

function DepegRow({ event, pegCurrency }: { event: DepegEvent; pegCurrency: string }) {
  const isOngoing = event.endedAt === null;
  const absBps = Math.abs(event.peakDeviationBps);
  const devColor = deviationColorClass(absBps);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs" title={formatEventDate(event.startedAt)}>
        <span className="font-mono">{formatEventDate(event.startedAt)}</span>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={
            event.direction === "below"
              ? "border-red-500/20 bg-red-500/10 text-xs text-red-700 dark:text-red-400"
              : "border-amber-500/20 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-400"
          }
        >
          {event.direction === "below" ? "Below" : "Above"}
        </Badge>
      </TableCell>
      <TableCell className={`text-right font-mono tabular-nums text-sm ${devColor}`}>
        {event.peakDeviationBps > 0 ? "+" : ""}
        {event.peakDeviationBps} bps
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums text-sm">
        {isOngoing ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            Ongoing
          </span>
        ) : (
          formatDuration(event.startedAt, event.endedAt)
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums text-sm">
        {formatNativePrice(event.startPrice, pegCurrency, event.pegReference)}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums text-sm">
        {event.peakPrice != null ? formatNativePrice(event.peakPrice, pegCurrency, event.pegReference) : "—"}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums text-sm">
        {event.recoveryPrice != null ? formatNativePrice(event.recoveryPrice, pegCurrency, event.pegReference) : "—"}
      </TableCell>
    </TableRow>
  );
}
