"use client";

import { useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, ExternalLink } from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import { formatAddress, formatEventDate, formatCurrency } from "@/lib/format";
import { isGoldStablecoin } from "@/lib/blacklist-helpers";
import type { BlacklistEvent } from "@/lib/types";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@/lib/classification";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useSortedTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";

interface BlacklistTableProps {
  events: BlacklistEvent[];
  isLoading: boolean;
  page: number;
  pageSize: number;
}

export function BlacklistTable({ events, isLoading, page, pageSize }: BlacklistTableProps) {
  type SortKey = "date" | "stablecoin" | "chain" | "event";
  const compareRows = useCallback(
    (a: BlacklistEvent, b: BlacklistEvent, sort: TableSortState<SortKey>): number => {
      let cmp = 0;
      switch (sort.key) {
        case "date":
          cmp = a.timestamp - b.timestamp;
          break;
        case "stablecoin":
          cmp = a.stablecoin.localeCompare(b.stablecoin);
          break;
        case "chain":
          cmp = a.chainName.localeCompare(b.chainName);
          break;
        case "event":
          cmp = a.eventType.localeCompare(b.eventType);
          break;
        default:
          cmp = a.timestamp - b.timestamp;
      }
      return sort.direction === "asc" ? cmp : -cmp;
    },
    []
  );
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown, sortedRows: sorted } =
    useSortedTableRows<BlacklistEvent, SortKey>(
      events,
      { defaultKey: "date", defaultDirection: "desc" },
      compareRows
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
        {Array.from({ length: 10 }).map((_, i) => (
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
    <div className="rounded-xl border overflow-x-auto">
      <div className="flex items-center justify-end px-3 py-1.5 border-b bg-muted/30">
        <span className="mr-auto text-xs text-muted-foreground sm:hidden">Swipe table for more</span>
        <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={handleCsvExport} disabled={sorted.length === 0}>
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
      <Table>
        <TableHeader className="bg-muted/80 backdrop-blur-sm">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <SortableTableHead
              sortKey="date"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Date"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
            />
            <SortableTableHead
              sortKey="stablecoin"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Stablecoin"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
            />
            <SortableTableHead
              sortKey="chain"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Chain"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
            />
            <SortableTableHead
              sortKey="event"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Event"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
            />
            <TableHead className="hidden md:table-cell">Address</TableHead>
            <TableHead className="hidden sm:table-cell text-right">Amount</TableHead>
            <TableHead className="hidden sm:table-cell text-center">Tx</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
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
                  className="block max-w-[120px] sm:max-w-none truncate sm:overflow-visible font-mono text-xs hover:underline"
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
                  className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </TableCell>
            </TableRow>
          ))}
          {paged.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                No blacklist events found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
