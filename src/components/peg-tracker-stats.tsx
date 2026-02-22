"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBps } from "@/lib/format";
import type { PegSummaryStats } from "@/lib/types";

interface PegTrackerStatsProps {
  summary: PegSummaryStats | null;
  isLoading: boolean;
}

export function PegTrackerStats({ summary, isLoading }: PegTrackerStatsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="rounded-2xl">
            <CardContent className="pt-6 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
      {/* Active Depegs */}
      <Card className="rounded-2xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active Depegs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tracking-tight">
              {summary.activeDepegCount}
            </span>
            {summary.activeDepegCount > 0 && (
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            coins &gt;100 bps off peg
          </p>
        </CardContent>
      </Card>

      {/* Median Deviation */}
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Median Deviation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-mono tracking-tight">
            {summary.medianDeviationBps} bps
          </div>
          <p className="text-xs text-muted-foreground">
            across all tracked coins
          </p>
        </CardContent>
      </Card>

      {/* Worst Current */}
      <Card className="rounded-2xl border-l-[3px] border-l-rose-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Worst Current
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.worstCurrent ? (
            <>
              <div className="text-2xl font-bold font-mono tracking-tight">
                {formatBps(summary.worstCurrent.bps)}
              </div>
              <p className="text-xs text-muted-foreground">
                {summary.worstCurrent.symbol}
              </p>
            </>
          ) : (
            <div className="text-2xl font-bold font-mono tracking-tight text-green-500">
              All at peg
            </div>
          )}
        </CardContent>
      </Card>

      {/* Coins At Peg */}
      <Card className="rounded-2xl border-l-[3px] border-l-green-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Coins at Peg
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-mono tracking-tight">
            {summary.coinsAtPeg}
            <span className="text-base text-muted-foreground font-normal">
              {" / "}{summary.totalTracked}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            within 100 bps
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
