"use client";

import { useState, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/table";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { ExternalLink } from "lucide-react";
import { useMintBurnEvents } from "@/hooks/use-mint-burn-flows";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { EventFeedSkeleton } from "@/components/event-feed-state";
import { QueryStateNotice } from "@/components/query-state-notice";
import {
  formatCurrency,
  formatAddress,
  formatTokenAmount,
  timeAgo,
  formatEventDate,
} from "@shared/lib/format";
import { FLOW_RECEIPT_TONE_CLASSES } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { MintBurnEvent } from "@shared/types/mint-burn";
import { cn } from "@/lib/utils";

interface FlowEventFeedProps {
  stablecoinId: string;
  limit?: number;
  scope?: "all" | "counted";
}

const DEFAULT_PAGE_SIZE = 25;
// The fetched page opens truncated so the history module stays glanceable.
const COLLAPSED_EVENT_COUNT = 6;
const FLOW_EVENT_COLUMNS: readonly DataTableColumn[] = [
  { id: "time", label: "Time" },
  { id: "type", label: "Type", className: "hidden sm:table-cell" },
  // No column takes all the slack: on a wide card that stranded Time, Type and
  // Chain at the left edge and the amounts at the far right.
  { id: "chain", label: "Chain", className: "hidden sm:table-cell" },
  { id: "amount", label: "Amount", className: "text-right" },
  { id: "tx", label: <><span className="sm:hidden">Chain</span><span className="sr-only">Transaction</span></>, className: "text-right" },
] as const;
/** One neutral type chip; the amount carries the sign and, for a counted mint or burn, its direction tone. */
const EVENT_CHIP_CLASS =
  "inline-flex items-center whitespace-nowrap rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground";

function chainName(chainId: string): string {
  return CHAIN_META[chainId]?.name ?? chainId;
}

function getEventLabel(event: MintBurnEvent): string {
  if (event.flowType === "atomic_roundtrip") return "Roundtrip";
  if (event.flowType === "bridge_transfer") return "Bridge";
  if (event.flowType === "protocol_internal") return "Internal";
  if (event.direction === "burn" && event.burnType === "review_required") return "Burn · review";
  return event.direction === "mint" ? "Mint" : "Burn";
}

/** A plain mint reads green and a plain burn red; roundtrip, bridge, internal and review rows are not counted flow and stay neutral. */
function flowAmountToneClass(evt: MintBurnEvent): string {
  if (evt.flowType !== "standard" || evt.burnType === "review_required") return "text-foreground";
  return evt.direction === "mint" ? FLOW_RECEIPT_TONE_CLASSES.mint : FLOW_RECEIPT_TONE_CLASSES.burn;
}

function formatFlowAmount(evt: MintBurnEvent): ReactNode {
  const sign = evt.direction === "mint" ? "+" : "−";
  if (evt.amountUsd != null) return `${sign}${formatCurrency(evt.amountUsd)}`;
  if (evt.amount > 0) {
    return (
      <>
        {sign}{formatTokenAmount(evt.amount)} {evt.symbol}
        <span className="ml-1 font-sans text-2xs text-muted-foreground">unpriced</span>
      </>
    );
  }
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Amount unavailable</span>
    </span>
  );
}

export function FlowEventFeed({ stablecoinId, limit, scope = "all" }: FlowEventFeedProps) {
  const pageSize = limit ?? DEFAULT_PAGE_SIZE;
  const [page, setPage] = useState(0);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const { data, isLoading, isError, refetch } = useMintBurnEvents(stablecoinId, {
    scope,
    limit: pageSize,
    offset: page * pageSize,
  });

  if (isLoading) return <EventFeedSkeleton variant="flow" />;
  if (isError) return <QueryStateNotice state="unavailable" label="Mint and burn event data" onRetry={refetch ? () => void refetch() : undefined} />;
  if ((!data || data.events.length === 0) && page === 0) {
    // The ledger keeps individual events only for a short recent window, while
    // window nets come from longer-retained hourly totals, so an empty ledger
    // must not read as "this coin never mints or burns".
    return (
      <p className="text-sm text-muted-foreground">
        No {scope === "counted" ? "counted " : ""}mint or burn events in the recent event ledger. Individual events are kept
        only for a short window; 30- and 90-day nets come from longer-kept hourly totals.
      </p>
    );
  }

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const isCollapsible = events.length > COLLAPSED_EVENT_COUNT;
  const visibleEvents = showAllEvents || !isCollapsible ? events : events.slice(0, COLLAPSED_EVENT_COUNT);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pagination = total > 0 && (showAllEvents || !isCollapsible) ? {
    page,
    totalPages,
    rangeStart: Math.min(page * pageSize + 1, total),
    rangeEnd: Math.min((page + 1) * pageSize, total),
    total,
    onPrevious: () => setPage((p) => Math.max(0, p - 1)),
    onNext: () => setPage((p) => Math.min(totalPages - 1, p + 1)),
    noun: "events",
  } : undefined;

  return (
    <>
      <DataTableShell
        tableId="mint-burn-event-feed"
        testId="mint-burn-event-feed-table"
        columns={FLOW_EVENT_COLUMNS}
        containerClassName="rounded-xl border overflow-hidden"
        mobileScrollHint={false}
        pagination={pagination}
      >
        {visibleEvents.map((evt) => (
          <TableRow key={evt.id}>
            <TableCell className="whitespace-nowrap px-2 font-mono text-xs text-muted-foreground sm:px-3">
              <time dateTime={new Date(evt.timestamp * 1000).toISOString()} title={formatEventDate(evt.timestamp)}>
                {timeAgo(evt.timestamp)}
              </time>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <span className={EVENT_CHIP_CLASS}>{getEventLabel(evt)}</span>
            </TableCell>
            <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{chainName(evt.chainId)}</TableCell>
            <TableCell className={cn("whitespace-nowrap px-2 text-right font-mono text-sm tabular-nums sm:px-3", flowAmountToneClass(evt))}>
              {/* Below sm the type column folds away; the sign shows direction and this names it. */}
              <span className="sr-only sm:hidden">{getEventLabel(evt)} </span>
              {formatFlowAmount(evt)}
            </TableCell>
            <TableCell className="px-2 text-right sm:px-3">
              <a
                href={evt.explorerTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex min-h-7 min-w-6 items-center justify-end gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground sm:min-h-6"
                aria-label={`View transaction ${formatAddress(evt.txHash)} on the ${chainName(evt.chainId)} block explorer`}
              >
                {/* Phone: the chain name doubles as the explorer link label. */}
                <span className="sm:hidden">{chainName(evt.chainId)}</span>
                <span className="hidden font-mono md:inline">{formatAddress(evt.txHash)}</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </TableCell>
          </TableRow>
        ))}
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
