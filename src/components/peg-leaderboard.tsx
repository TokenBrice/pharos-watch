"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSort } from "@/hooks/use-sort";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/sortable-table-head";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPegStability, formatBps } from "@/lib/format";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import type { PegSummaryCoin } from "@/lib/types";

interface PegLeaderboardProps {
  coins: PegSummaryCoin[];
  logos?: Record<string, string>;
  isLoading: boolean;
}

type SortKey = "pegScore" | "currentDeviationBps" | "pegPct" | "eventCount" | "worstDeviationBps" | "trackingSpanDays";

function formatSpan(days: number): string {
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem > 0 ? `${years}y ${rem}mo` : `${years}y`;
}

export function PegLeaderboard({ coins, logos, isLoading }: PegLeaderboardProps) {
  const prefetch = usePrefetchStablecoin();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<SortKey>("pegScore", "desc");

  const sorted = useMemo(() => {
    return [...coins].sort((a, b) => {
      const aRaw = a[sortKey];
      const bRaw = b[sortKey];
      // Null values always sort last regardless of direction
      if (aRaw == null && bRaw == null) return 0;
      if (aRaw == null) return 1;
      if (bRaw == null) return -1;
      const cmp = sortKey === "currentDeviationBps"
        ? Math.abs(bRaw as number) - Math.abs(aRaw as number)
        : (bRaw as number) - (aRaw as number);
      return sortDirection === "desc" ? cmp : -cmp;
    });
  }, [coins, sortKey, sortDirection]);

  const columns: { key: SortKey; label: string }[] = [
    { key: "pegScore", label: "Peg Score" },
    { key: "currentDeviationBps", label: "Current Dev." },
    { key: "pegPct", label: "Peg %" },
    { key: "eventCount", label: "Events" },
    { key: "worstDeviationBps", label: "Worst" },
    { key: "trackingSpanDays", label: "Tracking" },
  ];

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="pb-3">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Peg Score Leaderboard
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto scroll-shadow">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="sticky left-0 bg-background z-10 sm:min-w-[160px]">
                    Stablecoin
                  </TableHead>
                  {columns.map((col) => (
                    <SortableTableHead
                      key={col.key}
                      sortKey={col.key}
                      currentSortKey={sortKey}
                      sortDirection={sortDirection}
                      label={col.label}
                      toggleSort={toggleSort}
                      getAriaSortValue={getAriaSortValue}
                      handleSortKeyDown={handleSortKeyDown}
                      className="select-none whitespace-nowrap"
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((coin, i) => {
                  const isOdd = i % 2 !== 0;
                  return (
                  <TableRow key={coin.id} className={`hover:bg-muted/50 ${isOdd ? "bg-muted/30" : ""}`}>
                    <TableCell className={`sticky left-0 z-10 ${isOdd ? "bg-muted" : "bg-background"}`}>
                      <Link
                        href={`/stablecoin/${coin.id}`}
                        className="flex items-center gap-2 group"
                        onMouseEnter={() => prefetch(coin.id)}
                      >
                        <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                        <div className="min-w-0">
                          <span className="text-sm font-medium group-hover:underline">{coin.symbol}</span>
                          <span className="text-xs text-muted-foreground ml-1.5 hidden sm:inline">{coin.name}</span>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className={`font-mono font-semibold ${pegScoreColor(coin.pegScore)}`}>
                        {coin.pegScore !== null ? coin.pegScore : "N/A"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {coin.currentDeviationBps !== null ? (
                        <span className={`font-mono text-sm ${
                          Math.abs(coin.currentDeviationBps) < 10
                            ? "text-muted-foreground"
                            : deviationColorClass(Math.abs(coin.currentDeviationBps))
                        }`}>
                          {coin.currentDeviationBps >= 0 ? "+" : ""}{coin.currentDeviationBps} bps
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-sm">{formatPegStability(coin.pegPct)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-sm">{coin.eventCount}</span>
                    </TableCell>
                    <TableCell>
                      {coin.worstDeviationBps !== null ? (
                        <span className={`font-mono text-sm ${deviationColorClass(Math.abs(coin.worstDeviationBps))}`}>
                          {formatBps(coin.worstDeviationBps)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{formatSpan(coin.trackingSpanDays)}</span>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
