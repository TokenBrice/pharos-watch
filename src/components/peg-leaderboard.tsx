"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPegStability, formatWorstDeviation } from "@/lib/format";
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
  const [sortKey, setSortKey] = useState<SortKey>("pegScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

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
      return sortDir === "desc" ? cmp : -cmp;
    });
  }, [coins, sortKey, sortDir]);

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
                  <TableHead className="sticky left-0 bg-background z-10 min-w-[160px]">
                    Stablecoin
                  </TableHead>
                  {columns.map((col) => (
                    <TableHead
                      key={col.key}
                      className="cursor-pointer select-none whitespace-nowrap hover:bg-muted/50 transition-colors"
                      onClick={() => handleSort(col.key)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort(col.key); } }}
                      aria-sort={sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <div className="flex items-center gap-1">
                        {col.label}
                        {sortKey === col.key ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5 text-foreground" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5 text-foreground" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
                        )}
                      </div>
                    </TableHead>
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
                          {formatWorstDeviation(coin.worstDeviationBps)}
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
