"use client";

import Link from "next/link";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, ShieldOff } from "lucide-react";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";
import { formatAddress, formatCurrency, timeAgo, formatEventDate } from "@shared/lib/format";
import type { BlacklistEvent, BlacklistStablecoin } from "@shared/types";

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

const AMOUNT_SOURCE_LABELS: Record<string, string> = {
  event: "event",
  historical_balance: "historical",
  current_balance_snapshot: "snapshot",
  derived: "derived",
  legacy_migration: "legacy",
  unavailable: "unavailable",
};

const AMOUNT_STATUS_LABELS: Record<string, string> = {
  recoverable_pending: "pending recovery",
  provider_failed: "provider failed",
  ambiguous: "ambiguous",
  permanently_unavailable: "unavailable",
};

function formatFeedAmount(evt: BlacklistEvent): { primary: string; detail: string } {
  if (evt.amountUsdAtEvent != null) {
    return {
      primary: formatCurrency(evt.amountUsdAtEvent),
      detail: AMOUNT_SOURCE_LABELS[evt.amountSource] ?? evt.amountSource.replace(/_/g, " "),
    };
  }

  if (evt.amountNative != null && !(evt.amountNative === 0 && evt.eventType !== "destroy")) {
    const digits = isGoldBlacklistStablecoin(evt.stablecoin) ? 4 : 2;
    return {
      primary: `${evt.amountNative.toLocaleString(undefined, { maximumFractionDigits: digits })} ${evt.stablecoin}`,
      detail: AMOUNT_SOURCE_LABELS[evt.amountSource] ?? evt.amountSource.replace(/_/g, " "),
    };
  }

  return {
    primary: AMOUNT_STATUS_LABELS[evt.amountStatus] ?? evt.amountStatus.replace(/_/g, " "),
    detail: AMOUNT_SOURCE_LABELS[evt.amountSource] ?? evt.amountSource.replace(/_/g, " "),
  };
}

function FeedSkeleton() {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="bg-muted/50 h-10" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <div className="flex-1" />
          <Skeleton className="h-4 w-4 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function FeedEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
      <ShieldOff className="h-10 w-10 opacity-40" />
      <p className="text-sm">No blacklist events recorded yet.</p>
    </div>
  );
}

export function BlacklistDetailEventFeed({ symbol, limit = 10 }: Props) {
  const { data, isLoading, isError } = useBlacklistEventsPage({
    stablecoin: symbol,
    limit,
    offset: 0,
  });

  if (isLoading) return <FeedSkeleton />;
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Unable to load blacklist events. Please try again in a few moments.
      </div>
    );
  }
  if (!data || data.events.length === 0) return <FeedEmpty />;

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
              <TableCell className="text-center">
                <a
                  href={evt.explorerTxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="View transaction on block explorer"
                >
                  <span className="hidden md:inline">{formatAddress(evt.txHash)}</span>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </TableCell>
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
