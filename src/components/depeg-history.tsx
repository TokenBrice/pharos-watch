"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useTablePagination } from "@/hooks/use-table-pagination";
import { DepegProvenanceBadges } from "@/components/depeg-provenance-badges";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TablePagination } from "@/components/table-pagination";
import { TableCell, TableRow } from "@/components/table";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { RelatedIncidentsRail } from "@/components/related-incidents-rail";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { formatDuration, formatNativePrice, formatEventDate, formatBps, formatCurrency } from "@shared/lib/format";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-config";
import { deviationColorClass } from "@/lib/severity-colors";
import { CLIENT_TRACKED_STABLECOINS as TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { computePegStability } from "@/lib/peg-stability";
import { cn } from "@/lib/utils";
import type { DepegEvent, PegSummaryCoin } from "@shared/types";

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
// Incident-heavy coins otherwise open with a 25-row wall; the rest stays one tap away.
const DEPEG_HISTORY_COLLAPSED_COUNT = 6;
const EMPTY_EVENTS: DepegEvent[] = [];
const DEPEG_HISTORY_DESCRIPTION =
  "Recorded depeg incidents for this stablecoin, sorted newest first. One incident can contain multiple threshold crossings.";
const DEPEG_HISTORY_COLUMNS: readonly DataTableColumn[] = [
  { id: "date", label: "Date" },
  { id: "direction", label: "Direction" },
  { id: "peakDeviation", label: "Peak Deviation", className: "text-right" },
  { id: "duration", label: "Duration", className: "text-right" },
  { id: "startPrice", label: "Start Price", className: "hidden lg:table-cell text-right" },
  { id: "peakPrice", label: "Peak Price", className: "hidden lg:table-cell text-right" },
  { id: "recoveryPrice", label: "Recovery Price", className: "hidden lg:table-cell text-right" },
] as const;

function DepegHistoryShell({ children }: { children: ReactNode }) {
  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Depeg History</StablecoinModuleTitle>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        <p className="text-sm text-muted-foreground">{DEPEG_HISTORY_DESCRIPTION}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export function DepegHistory({
  stablecoinId,
  earliestTrackingDate,
  hasPriceData = true,
  depegEventCoverageLimited = false,
  historyCoverage = null,
  recent90d = null,
}: {
  stablecoinId: string;
  earliestTrackingDate?: number | null;
  hasPriceData?: boolean;
  depegEventCoverageLimited?: boolean;
  historyCoverage?: PegSummaryCoin["historyCoverage"];
  recent90d?: PegSummaryCoin["recent90d"];
}) {
  const { data, isLoading, error, refetch, isFetchingNextPage, loadedCount, isFullyLoaded } = useInfiniteDepegEvents({
    stablecoinId,
    autoLoadAll: true,
  });
  const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
  const pegCurrency = meta?.flags.pegCurrency ?? "USD";
  const events = data?.events ?? EMPTY_EVENTS;
  const totalIncidents = data?.counts?.incidents ?? data?.total ?? events.length;
  const thresholdCrossings = data?.counts?.thresholdCrossings ?? (
    isFullyLoaded ? events.reduce((sum, event) => sum + (event.constituentEventCount ?? 1), 0) : null
  );
  const sorted = useMemo(() => sortEvents(events), [events]);
  const metrics = isFullyLoaded ? computePegStability(sorted, earliestTrackingDate ?? null) : null;
  const worstDeviationBps = metrics?.worstDeviationBps ?? null;
  const [showAllIncidents, setShowAllIncidents] = useState(false);
  const { effectivePage, totalPages, paginatedRows, rangeStart, rangeEnd, onPreviousPage, onNextPage } =
    useTablePagination(sorted, { pageSize: DEPEG_HISTORY_PAGE_SIZE });
  const isHydratingFullHistory = totalIncidents > loadedCount;
  const isCollapsible = sorted.length > DEPEG_HISTORY_COLLAPSED_COUNT;
  const isFolded = isCollapsible && !showAllIncidents;
  // Folded always shows the newest incidents, whichever page the reader left open.
  const visibleRows = isFolded ? sorted.slice(0, DEPEG_HISTORY_COLLAPSED_COUNT) : paginatedRows;
  const showPagination = isFullyLoaded && totalIncidents > 0 && !isFolded;

  if (isLoading) {
    return (
      <DepegHistoryShell>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </DepegHistoryShell>
    );
  }

  if (error && !data?.events?.length) {
    return (
      <DepegHistoryShell>
        <QueryErrorNotice error={error} onRetry={() => void refetch()} />
      </DepegHistoryShell>
    );
  }

  if (!error && events.length === 0) {
    const noData = !hasPriceData;
    return (
      <DepegHistoryShell>
        {noData ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              No depeg incidents recorded. No price data available to verify peg status.
            </p>
          </div>
        ) : depegEventCoverageLimited ? (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              No depeg incidents recorded. This coin is currently below the {formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)}{" "}
              live depeg-event floor, so Pharos shows the price deviation but does not open live depeg events at this
              size.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              No depeg incidents are recorded in the observed coverage window.
            </p>
          </div>
        )}
      </DepegHistoryShell>
    );
  }

  return (
    <DepegHistoryShell>
      {error ? (
        <div>
          <QueryErrorNotice error={error} hasData onRetry={() => void refetch()} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-muted-foreground">Incidents </span>
          <span className="font-mono font-semibold">{totalIncidents.toLocaleString()}</span>
        </div>
        {thresholdCrossings != null ? (
          <div>
            <span className="text-muted-foreground">Threshold crossings </span>
            <span className="font-mono font-semibold">{thresholdCrossings.toLocaleString()}</span>
          </div>
        ) : null}
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
              <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                {metrics.currentStreakDays}d at peg
              </span>
            ) : (
              <span className="font-mono font-semibold text-muted-foreground">—</span>
            )}
          </div>
        ) : null}
      </div>
      {recent90d ? (
        <div className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Recent 90d: </span>
          <span className="font-mono">{recent90d.pegPct.toFixed(1)}%</span> at peg across{" "}
          <span className="font-mono">{Math.floor(recent90d.observedDays)}d</span> observed, with{" "}
          <span className="font-mono">{recent90d.incidentCount}</span> incidents and{" "}
          <span className="font-mono">{recent90d.thresholdCrossingCount}</span> threshold crossings
          {recent90d.coverageLimited ? " (partial 90-day coverage)" : ""}.
        </div>
      ) : null}
      {historyCoverage ? (
        <p className="text-xs text-muted-foreground">
          Score coverage: {historyCoverage.status === "verified" ? "replay-verified" : "age-anchored"} since{" "}
          <span className="font-mono">{formatEventDate(historyCoverage.startedAt)}</span>.
        </p>
      ) : null}
      {isHydratingFullHistory ? (
        <p className="mb-3 text-xs text-muted-foreground">
          Loading full history... {loadedCount.toLocaleString()} / {totalIncidents.toLocaleString()} incidents
          {isFetchingNextPage ? "" : " loaded"}
        </p>
      ) : null}
      <ol className="space-y-2 md:hidden" aria-label="Compact depeg event history">
        {visibleRows.map((event) => (
          <DepegEventCard key={event.id} event={event} pegCurrency={pegCurrency} />
        ))}
      </ol>
      {showPagination ? (
        <TablePagination
          page={effectivePage}
          totalPages={totalPages}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={totalIncidents}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
          noun="incidents"
          className="mt-3 rounded-xl border border-border/60 md:hidden"
        />
      ) : null}
      <DataTableShell
        tableId="stablecoin-depeg-history"
        testId="stablecoin-depeg-history-table"
        columns={DEPEG_HISTORY_COLUMNS}
        containerClassName="hidden rounded-xl border overflow-hidden md:block"
        tableClassName="min-w-[420px]"
        pagination={
          showPagination
            ? {
                page: effectivePage,
                totalPages,
                rangeStart,
                rangeEnd,
                total: totalIncidents,
                onPrevious: onPreviousPage,
                onNext: onNextPage,
                noun: "incidents",
              }
            : undefined
        }
      >
        {visibleRows.map((event) => (
          <DepegRow key={event.id} event={event} pegCurrency={pegCurrency} />
        ))}
      </DataTableShell>
      {isCollapsible ? (
        <ShowAllToggle
          open={showAllIncidents}
          onToggle={() => setShowAllIncidents((prev) => !prev)}
          total={totalIncidents}
          noun="incidents"
        />
      ) : null}
      <RelatedIncidentsRail pegCurrency={pegCurrency} riskArchetype={meta?.mechanismArchetype} className="mt-5" />
    </DepegHistoryShell>
  );
}

function DepegEventCard({ event, pegCurrency }: { event: DepegEvent; pegCurrency: string }) {
  const isOngoing = event.endedAt === null;
  const absBps = Math.abs(event.peakDeviationBps);
  const devColor = deviationColorClass(absBps);

  return (
    <li className="rounded-lg border border-border/60 bg-background/45 px-3 py-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{formatEventDate(event.startedAt)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
            <span className="text-[11px] text-muted-foreground">
              {event.source}
              {(event.constituentEventCount ?? 1) > 1 ? ` · ${event.constituentEventCount} crossings` : ""}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={`font-mono text-sm font-semibold tabular-nums ${devColor}`}>
            {event.peakDeviationBps > 0 ? "+" : ""}
            {event.peakDeviationBps} bps
          </p>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
            {isOngoing ? "Ongoing" : formatDuration(event.startedAt, event.endedAt)}
          </p>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-border/40 pt-2 text-[11px]">
        <div>
          <dt className="text-muted-foreground">Start</dt>
          <dd className="mt-0.5 font-mono tabular-nums">
            {formatNativePrice(event.startPrice, pegCurrency, event.pegReference)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Peak</dt>
          <dd className="mt-0.5 font-mono tabular-nums">
            {event.peakPrice != null ? formatNativePrice(event.peakPrice, pegCurrency, event.pegReference) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Recovery</dt>
          <dd className="mt-0.5 font-mono tabular-nums">
            {event.recoveryPrice != null
              ? formatNativePrice(event.recoveryPrice, pegCurrency, event.pegReference)
              : "—"}
          </dd>
        </div>
      </dl>
    </li>
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
        <DepegProvenanceBadges
          pendingReason={event.pendingReason}
          confirmationSources={event.confirmationSources}
          source={event.source}
          reasonLeadingClass="ml-2"
        />
        {(event.constituentEventCount ?? 1) > 1 ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {event.constituentEventCount} crossings
          </span>
        ) : null}
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
