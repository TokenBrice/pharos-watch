"use client";

import { useState, type ReactNode } from "react";
import {
  TableCell,
  TableRow,
} from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TablePagination } from "@/components/table-pagination";
import { ExternalLink } from "lucide-react";
import { useMintBurnEvents } from "@/hooks/use-mint-burn-flows";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { EventFeedEmpty, EventFeedSkeleton, EventTransactionCell } from "@/components/event-feed-state";
import {
  formatCurrency,
  formatAddress,
  formatTokenAmount,
  timeAgo,
  formatEventDate,
} from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import type { MintBurnEvent } from "@shared/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowEventFeedProps {
  stablecoinId: string;
  limit?: number;
  scope?: "all" | "counted";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
// The fetched page opens truncated so the history module stays glanceable.
const COLLAPSED_EVENT_COUNT = 6;
const FLOW_EVENT_COLUMNS: readonly DataTableColumn[] = [
  { id: "time", label: "Time" },
  { id: "direction", label: "Direction" },
  { id: "amount", label: "Amount", className: "text-right" },
  { id: "chain", label: "Chain", className: "hidden sm:table-cell" },
  { id: "tx", label: "Tx", className: "text-center" },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chainName(chainId: string): string {
  return CHAIN_META[chainId]?.name ?? chainId;
}

function getEventBadge(event: MintBurnEvent): {
  label: string;
  className: string;
} {
  if (event.flowType === "atomic_roundtrip") {
    return {
      label: "Roundtrip",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 text-xs",
    };
  }

  if (event.flowType === "bridge_transfer") {
    return {
      label: "Bridge transfer",
      className: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20 text-xs",
    };
  }

  if (event.direction === "burn" && event.burnType === "review_required") {
    return {
      label: "Review burn",
      className: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border-yellow-500/20 text-xs",
    };
  }

  if (event.direction === "mint") {
    return {
      label: "Mint",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs",
    };
  }

  return {
    label: "Burn",
    className: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20 text-xs",
  };
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function FeedError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
      Unable to load event data. {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FlowEventFeed({ stablecoinId, limit, scope = "all" }: FlowEventFeedProps) {
  const pageSize = limit ?? DEFAULT_PAGE_SIZE;
  const [page, setPage] = useState(0);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const { data, isLoading, isError } = useMintBurnEvents(stablecoinId, {
    scope,
    limit: pageSize,
    offset: page * pageSize,
  });

  if (isLoading) return <EventFeedSkeleton variant="flow" />;
  if (isError) return <FeedError message="Please try again in a few moments." />;
  if (!data || data.events.length === 0) {
    if (page === 0) return <EventFeedEmpty variant="flow" />;
    // If we paginated past the end, show the table with a "no more" message
  }

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const isCollapsible = events.length > COLLAPSED_EVENT_COUNT;
  const visibleEvents = showAllEvents || !isCollapsible ? events : events.slice(0, COLLAPSED_EVENT_COUNT);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showingStart = Math.min(page * pageSize + 1, total);
  const showingEnd = Math.min((page + 1) * pageSize, total);
  const pagination = total > 0 && (showAllEvents || !isCollapsible) ? {
    page,
    totalPages,
    rangeStart: showingStart,
    rangeEnd: showingEnd,
    total,
    onPrevious: () => setPage((p) => Math.max(0, p - 1)),
    onNext: () => setPage((p) => Math.min(totalPages - 1, p + 1)),
    noun: "events",
  } : undefined;

  return (
    <>
      <ol className="space-y-2 md:hidden" aria-label="Compact mint and burn events">
        {visibleEvents.map((evt) => (
          <FlowEventCard key={evt.id} event={evt} />
        ))}
        {events.length === 0 ? (
          <li className="rounded-xl border border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">
            No more events.
          </li>
        ) : null}
      </ol>
      {pagination ? (
        <TablePagination
          {...pagination}
          className="mt-3 rounded-xl border border-border/60 md:hidden"
        />
      ) : null}
      <DataTableShell
        tableId="mint-burn-event-feed"
        testId="mint-burn-event-feed-table"
        columns={FLOW_EVENT_COLUMNS}
        containerClassName="hidden rounded-xl border overflow-hidden md:block"
        tableClassName="min-w-[420px]"
        pagination={pagination}
      >
        {visibleEvents.map((evt) => {
          const badge = getEventBadge(evt);
          return (
            <TableRow key={evt.id}>
              <TableCell
                className="whitespace-nowrap text-xs"
                title={formatEventDate(evt.timestamp)}
              >
                <span className="font-mono">{timeAgo(evt.timestamp)}</span>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={badge.className}
                >
                  {badge.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-sm">
                {formatFlowAmount(evt)}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-sm">
                {chainName(evt.chainId)}
              </TableCell>
              <EventTransactionCell txHash={evt.txHash} href={evt.explorerTxUrl} />
            </TableRow>
          );
        })}
        {events.length === 0 && (
          <DataTableEmptyRow colSpan={FLOW_EVENT_COLUMNS.length}>No more events.</DataTableEmptyRow>
        )}
      </DataTableShell>
      {isCollapsible ? (
        <ShowAllToggle
          open={showAllEvents}
          onToggle={() => setShowAllEvents((prev) => !prev)}
          total={total}
          noun="events"
        />
      ) : null}
    </>
  );
}

function formatFlowAmount(evt: MintBurnEvent): ReactNode {
  if (evt.amountUsd != null) return formatCurrency(evt.amountUsd);
  if (evt.amount > 0) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span>{formatTokenAmount(evt.amount)} {evt.symbol}</span>
        <Badge variant="outline" className="text-xs">
          Unpriced
        </Badge>
      </div>
    );
  }
  return <span className="text-muted-foreground">&mdash;</span>;
}

function FlowEventCard({ event }: { event: MintBurnEvent }) {
  const badge = getEventBadge(event);

  return (
    <li className="rounded-lg border border-border/60 bg-background/45 px-3 py-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground" title={formatEventDate(event.timestamp)}>
            {timeAgo(event.timestamp)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={badge.className}>
              {badge.label}
            </Badge>
            <span className="text-xs text-muted-foreground">{chainName(event.chainId)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-sm tabular-nums">
          {event.amountUsd != null ? (
            formatCurrency(event.amountUsd)
          ) : event.amount > 0 ? (
            <span>{formatTokenAmount(event.amount)} {event.symbol}</span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </div>
      </div>
      <a
        href={event.explorerTxUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring mt-2 inline-flex min-h-10 items-center gap-1 rounded-md font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-label="View transaction on block explorer"
      >
        {formatAddress(event.txHash)}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </li>
  );
}
