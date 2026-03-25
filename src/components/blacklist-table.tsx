"use client";

import { useCallback } from "react";
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
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import type { BlacklistEvent, BlacklistSortDirection, BlacklistSortKey } from "@shared/types";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";
import { getNextSortState, shouldToggleSortOnKeyDown } from "@/hooks/use-sort";

const SKELETON_ROWS = Array.from({ length: 10 }, (_, i) => i);

interface BlacklistTableProps {
  events: BlacklistEvent[];
  isLoading: boolean;
  page: number;
  pageSize: number;
  sortKey: BlacklistSortKey;
  sortDirection: BlacklistSortDirection;
  onSortChange: (sortKey: BlacklistSortKey, sortDirection: BlacklistSortDirection) => void;
}

const BLACKLIST_COLUMNS: readonly DataTableColumn<BlacklistSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "date", label: "Date", sortKey: "date" },
  { id: "stablecoin", label: "Stablecoin", sortKey: "stablecoin" },
  { id: "chain", label: "Chain", sortKey: "chain" },
  { id: "event", label: "Event", sortKey: "event" },
  { id: "address", label: "Address", className: "hidden md:table-cell" },
  { id: "amount", label: "Amount / Value", className: "hidden sm:table-cell text-right" },
  { id: "tx", label: "Tx", className: "hidden sm:table-cell text-center" },
] as const;

export function BlacklistTable({
  events,
  isLoading,
  page,
  pageSize,
  sortKey,
  sortDirection,
  onSortChange,
}: BlacklistTableProps) {
  const toggleSort = useCallback((key: BlacklistSortKey) => {
    const next = getNextSortState({ key: sortKey, direction: sortDirection }, key);
    onSortChange(next.key, next.direction);
  }, [onSortChange, sortDirection, sortKey]);

  const getAriaSortValue = useCallback((columnKey: BlacklistSortKey): "ascending" | "descending" | "none" => {
    if (sortKey !== columnKey) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  }, [sortDirection, sortKey]);

  const handleSortKeyDown = useCallback((e: React.KeyboardEvent, key: BlacklistSortKey) => {
    if (shouldToggleSortOnKeyDown(e.key)) {
      e.preventDefault();
      toggleSort(key);
    }
  }, [toggleSort]);

  const handleCsvExport = useCallback(() => {
    downloadCsv(events, [
      { header: "Date", accessor: (row) => formatEventDate(row.timestamp) },
      { header: "Stablecoin", accessor: (row) => row.stablecoin },
      { header: "Chain", accessor: (row) => row.chainName },
      { header: "Event", accessor: (row) => EVENT_LABELS[row.eventType] ?? row.eventType },
      { header: "Address", accessor: (row) => row.address },
      {
        header: "Amount",
        accessor: (row) =>
          row.amountNative != null && !(row.amountNative === 0 && row.eventType !== "destroy")
            ? row.amountNative
            : null,
      },
      { header: "Amount USD At Event", accessor: (row) => row.amountUsdAtEvent },
      { header: "Amount Status", accessor: (row) => row.amountStatus },
      { header: "Tx URL", accessor: (row) => row.explorerTxUrl },
    ], "pharos-freeze-events");
  }, [events]);

  if (isLoading) {
    return (
      <div className="rounded-xl border overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="bg-muted/80 h-10">
              {BLACKLIST_COLUMNS.map((col) => (
                <th key={col.id} className={col.className}>
                  <Skeleton className="h-3 w-12 inline-block" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SKELETON_ROWS.map((i) => (
              <tr key={i} className="border-t">
                <td className="px-4 py-2 text-right"><Skeleton className="h-4 w-6" /></td>
                <td className="px-4 py-2"><Skeleton className="h-4 w-24" /></td>
                <td className="px-4 py-2"><Skeleton className="h-4 w-14" /></td>
                <td className="px-4 py-2"><Skeleton className="h-4 w-16" /></td>
                <td className="px-4 py-2"><Skeleton className="h-5 w-16 rounded-full" /></td>
                <td className="hidden md:table-cell px-4 py-2"><Skeleton className="h-4 w-28" /></td>
                <td className="hidden sm:table-cell px-4 py-2 text-right"><Skeleton className="h-4 w-16" /></td>
                <td className="hidden sm:table-cell px-4 py-2 text-center"><Skeleton className="h-4 w-4" /></td>
              </tr>
            ))}
          </tbody>
        </table>
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
          <Button variant="outline" size="sm" className="pharos-focus-ring min-h-11 sm:min-h-8" onClick={handleCsvExport} disabled={events.length === 0}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      }
    >
      {events.map((evt, index) => (
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
                  aria-label={`View address ${evt.address} on ${evt.chainName}`}
                >
                  {formatAddress(evt.address)}
                </a>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right font-mono">
                {evt.amountUsdAtEvent != null
                  ? formatCurrency(evt.amountUsdAtEvent)
                  : evt.amountNative != null && !(evt.amountNative === 0 && evt.eventType !== "destroy")
                    ? isGoldBlacklistStablecoin(evt.stablecoin)
                      ? `${evt.amountNative.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${evt.stablecoin}`
                      : `${evt.amountNative.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${evt.stablecoin}`
                    : evt.amountStatus === "permanently_unavailable"
                      ? "N/A"
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
      {events.length === 0 && (
        <TableRow>
          <TableCell colSpan={BLACKLIST_COLUMNS.length} className="text-center text-muted-foreground py-12">
            No blacklist events match your filters.
          </TableCell>
        </TableRow>
      )}
    </DataTableShell>
  );
}
