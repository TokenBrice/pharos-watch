"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpDown, ArrowUp, ArrowDown, ExternalLink } from "lucide-react";
import { formatAddress, formatEventDate, formatCurrency } from "@/lib/format";
import type { BlacklistEvent, SortConfig } from "@/lib/types";

interface BlacklistTableProps {
  events: BlacklistEvent[];
  isLoading: boolean;
  page: number;
  pageSize: number;
}

const EVENT_BADGE_STYLES: Record<string, string> = {
  blacklist: "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400",
  unblacklist: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  destroy: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
};

const EVENT_LABELS: Record<string, string> = {
  blacklist: "Blacklist",
  unblacklist: "Unblacklist",
  destroy: "Destroy",
};

function SortIcon({ columnKey, sort }: { columnKey: string; sort: SortConfig }) {
  if (sort.key !== columnKey) return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 text-muted-foreground/50" />;
  return sort.direction === "asc" ? (
    <ArrowUp className="ml-1 inline h-3.5 w-3.5 text-foreground" />
  ) : (
    <ArrowDown className="ml-1 inline h-3.5 w-3.5 text-foreground" />
  );
}

export function BlacklistTable({ events, isLoading, page, pageSize }: BlacklistTableProps) {
  const [sort, setSort] = useState<SortConfig>({ key: "date", direction: "desc" });

  const sorted = useMemo(() => {
    return [...events].sort((a, b) => {
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
    });
  }, [events, sort]);

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize]);

  function toggleSort(key: string) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" }
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border overflow-hidden">
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
    <div className="rounded-xl border table-header-sticky table-striped overflow-x-auto scroll-shadow">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort("date")} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort("date"); } }} aria-sort={sort.key === "date" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              Date <SortIcon columnKey="date" sort={sort} />
            </TableHead>
            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort("stablecoin")} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort("stablecoin"); } }} aria-sort={sort.key === "stablecoin" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              Stablecoin <SortIcon columnKey="stablecoin" sort={sort} />
            </TableHead>
            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort("chain")} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort("chain"); } }} aria-sort={sort.key === "chain" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              Chain <SortIcon columnKey="chain" sort={sort} />
            </TableHead>
            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort("event")} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort("event"); } }} aria-sort={sort.key === "event" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              Event <SortIcon columnKey="event" sort={sort} />
            </TableHead>
            <TableHead>Address</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-center">Tx</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.map((evt, index) => (
            <TableRow key={evt.id} className="hover:bg-muted/70">
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
              <TableCell>
                <a
                  href={evt.explorerAddressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block max-w-[120px] sm:max-w-none truncate sm:overflow-visible font-mono text-xs hover:underline"
                >
                  {formatAddress(evt.address)}
                </a>
              </TableCell>
              <TableCell className="text-right font-mono">
                {evt.amount != null && !(evt.amount === 0 && evt.eventType !== "destroy")
                  ? (evt.stablecoin === "PAXG" || evt.stablecoin === "XAUT")
                    ? `${evt.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${evt.stablecoin}`
                    : formatCurrency(evt.amount)
                  : "\u2014"}
              </TableCell>
              <TableCell className="text-center">
                <a
                  href={evt.explorerTxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </TableCell>
            </TableRow>
          ))}
          {paged.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                No blacklist events found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
