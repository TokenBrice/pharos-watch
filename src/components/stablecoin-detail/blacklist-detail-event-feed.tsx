"use client";

import Link from "next/link";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { EventFeedEmpty, EventFeedSkeleton, EventTransactionCell } from "@/components/event-feed-state";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";
import { formatAddress, formatCurrency, timeAgo, formatEventDate } from "@shared/lib/format";
import type { BlacklistEvent, BlacklistStablecoin } from "@shared/types";
import {
  formatBlacklistNativeAmount,
  getBlacklistAmountSourceLabel,
  getBlacklistAmountStatusLabel,
} from "@/lib/blacklist-event-presentation";

const COLUMNS: readonly DataTableColumn[] = [
  { id: "time", label: "Time" },
  { id: "event", label: "Event" },
  { id: "address", label: "Address" },
  { id: "amount", label: "Amount", className: "text-right" },
  { id: "chain", label: "Chain", className: "hidden sm:table-cell" },
  { id: "tx", label: "Tx", className: "text-center" },
] as const;

interface Props {
  symbol: BlacklistStablecoin;
  limit?: number;
}

function eventBadge(eventType: BlacklistEvent["eventType"]) {
  return {
    label: EVENT_LABELS[eventType],
    className: `${EVENT_BADGE_STYLES[eventType]} text-xs`,
  };
}

function formatFeedAmount(evt: BlacklistEvent): { primary: string; detail: string } {
  if (evt.amountUsdAtEvent != null) {
    return {
      primary: formatCurrency(evt.amountUsdAtEvent),
      detail: getBlacklistAmountSourceLabel(evt),
    };
  }

  if (evt.amountNative != null && !(evt.amountNative === 0 && evt.eventType !== "destroy")) {
    return {
      primary: `${formatBlacklistNativeAmount(evt)} ${evt.stablecoin}`,
      detail: getBlacklistAmountSourceLabel(evt),
    };
  }

  return {
    primary: getBlacklistAmountStatusLabel(evt),
    detail: getBlacklistAmountSourceLabel(evt),
  };
}

export function BlacklistDetailEventFeed({ symbol, limit = 10 }: Props) {
  const { data, isLoading, isError } = useBlacklistEventsPage({
    stablecoin: symbol,
    limit,
    offset: 0,
  });

  if (isLoading) return <EventFeedSkeleton variant="blacklist" />;
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Unable to load blacklist events. Please try again in a few moments.
      </div>
    );
  }
  if (!data || data.events.length === 0) return <EventFeedEmpty variant="blacklist" />;

  return (
    <>
      <DataTableShell
        tableId="stablecoin-blacklist-events"
        testId="stablecoin-blacklist-events-table"
        columns={COLUMNS}
        containerClassName="rounded-xl border overflow-hidden"
        tableClassName="min-w-[360px] sm:min-w-[520px]"
      >
        {data.events.map((evt) => {
          const badge = eventBadge(evt.eventType);
          const amount = formatFeedAmount(evt);
          return (
            <TableRow key={evt.id}>
              <TableCell className="whitespace-nowrap text-xs" title={formatEventDate(evt.timestamp)}>
                <span className="font-mono">{timeAgo(evt.timestamp)}</span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={badge.className}>
                  {badge.label}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                <a
                  href={evt.explorerAddressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {formatAddress(evt.address)}
                </a>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-sm">
                <span
                  className={evt.amountUsdAtEvent == null && evt.amountNative == null ? "text-muted-foreground" : ""}
                >
                  {amount.primary}
                </span>
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{amount.detail}</span>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-sm">{evt.chainName}</TableCell>
              <EventTransactionCell txHash={evt.txHash} href={evt.explorerTxUrl} />
            </TableRow>
          );
        })}
      </DataTableShell>
      <div className="mt-3 flex justify-end">
        <Link
          href={`/freezewatch/?stablecoin=${symbol}`}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          See all events →
        </Link>
      </div>
    </>
  );
}
