"use client";

import { useCallback, useMemo } from "react";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, ExternalLink } from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import { formatAddress, formatEventDate, formatCurrency } from "@shared/lib/format";
import { isGoldStablecoin } from "@/lib/blacklist-helpers";
import type { BlacklistEvent } from "@shared/types";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";

const SKELETON_ROWS = Array.from({ length: 10 }, (_, i) => i);
import { useSortedTableRows } from "@/hooks/use-sorted-table-rows";
import { compareBlacklistRows, type BlacklistSortKey } from "@/components/blacklist-table-logic";

interface BlacklistTableProps {
  events: BlacklistEvent[];
  isLoading: boolean;
  page: number;
  pageSize: number;
}

const BLACKLIST_COLUMNS: readonly DataTableColumn<BlacklistSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "date", label: "Date", sortKey: "date" },
  { id: "stablecoin", label: "Stablecoin", sortKey: "stablecoin" },
  { id: "chain", label: "Chain", sortKey: "chain" },
  { id: "event", label: "Event", sortKey: "event" },
  { id: "address", label: "Address", className: "hidden md:table-cell" },
  { id: "amount", label: "Amount", className: "hidden sm:table-cell text-right" },
  { id: "tx", label: "Tx", className: "hidden sm:table-cell text-center" },
] as const;

export function BlacklistTable({ events, isLoading, page, pageSize }: BlacklistTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown, sortedRows: sorted } =
    useSortedTableRows<BlacklistEvent, BlacklistSortKey>(
      events,
      { defaultKey: "date", defaultDirection: "desc" },
      compareBlacklistRows,
    );

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize]);

  const handleCsvExport = useCallback(() => {
    downloadCsv(sorted, [
      { header: "Date", accessor: (row) => formatEventDate(row.timestamp) },
      { header: "Stablecoin", accessor: (row) => row.stablecoin },
      { header: "Chain", accessor: (row) => row.chainName },
      { header: "Event", accessor: (row) => EVENT_LABELS[row.eventType] ?? row.eventType },
      { header: "Address", accessor: (row) => row.address },
      {
        header: "Amount",
        accessor: (row) =>
          row.amount != null && !(row.amount === 0 && row.eventType !== "destroy")
            ? row.amount
            : null,
      },
      { header: "Tx URL", accessor: (row) => row.explorerTxUrl },
    ], "pharos-freeze-events");
  }, [sorted]);

  if (isLoading) {
    return (
      <div className="rounded-xl border overflow-x-auto">
        <div className="bg-muted/50 h-10" />
        {SKELETON_ROWS.map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
            <Skeleton className="h-4 w-8 shrink-0" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-4 shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <DataTableShell
      columns={BLACKLIST_COLUMNS}
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
        handleSortKeyDown,
      }}
      striped
      containerClassName="rounded-xl border"
      headerClassName="bg-muted/80 backdrop-blur-sm"
      topSlot={
        <div className="flex items-center justify-end px-3 py-1.5 border-b bg-muted/30">
          <span className="mr-auto text-xs text-muted-foreground sm:hidden">Swipe table for more</span>
          <Button variant="outline" size="sm" className="pharos-focus-ring min-h-11 sm:min-h-8" onClick={handleCsvExport} disabled={sorted.length === 0}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      }
    >
      {paged.map((evt, index) => (
            <TableRow key={evt.id}>
              <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                {(page - 1) * pageSize + index + 1}
              </TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">{formatEventDate(evt.timestamp)}</TableCell>
              <TableCell className="font-medium">{evt.stablecoin}</TableCell>
              <TableCell>{evt.chainName}</TableCell>
              <TableCell>
                <Badge variant="outline" className={EVENT_BADGE_STYLES[evt.eventType] ?? ""}>
                  {EVENT_LABELS[evt.eventType] ?? evt.eventType}
                </Badge>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <a
                  href={evt.explorerAddressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring block max-w-[120px] sm:max-w-none truncate sm:overflow-visible font-mono text-xs hover:underline"
                >
                  {formatAddress(evt.address)}
                </a>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right font-mono">
                {evt.amount != null && !(evt.amount === 0 && evt.eventType !== "destroy")
                  ? isGoldStablecoin(evt.stablecoin)
                    ? `${evt.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${evt.stablecoin}`
                    : formatCurrency(evt.amount)
                  : "\u2014"}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-center">
                <a
                  href={evt.explorerTxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={`Open ${evt.chainName} transaction ${evt.txHash} in explorer`}
                  title={`View tx ${evt.txHash.slice(0, 10)}... on ${evt.chainName}`}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </TableCell>
            </TableRow>
          ))}
      {paged.length === 0 && (
        <TableRow>
          <TableCell colSpan={BLACKLIST_COLUMNS.length} className="text-center text-muted-foreground py-12">
            No blacklist events match your filters.
          </TableCell>
        </TableRow>
      )}
    </DataTableShell>
  );
}
