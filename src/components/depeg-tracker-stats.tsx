"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PegSummaryStats } from "@shared/types";

interface DepegTrackerStatsProps {
  stats: PegSummaryStats;
}

export function DepegTrackerStats({ stats }: DepegTrackerStatsProps) {
  const eventDelta = stats.depegEventsToday - stats.depegEventsYesterday;
  const deltaLabel =
    eventDelta > 0 ? `+${eventDelta} vs yesterday` :
    eventDelta < 0 ? `${eventDelta} vs yesterday` :
    "same as yesterday";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Card className="rounded-xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active Depegs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.activeDepegCount}</p>
          <p className="text-xs text-muted-foreground">ongoing events</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-green-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Coins at Peg
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.coinsAtPeg}</p>
          <p className="text-xs text-muted-foreground">of {stats.totalTracked} tracked</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-blue-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Median Deviation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.medianDeviationBps} bps</p>
          <p className="text-xs text-muted-foreground">across all coins</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Total Tracked
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.totalTracked}</p>
          <p className="text-xs text-muted-foreground">stablecoins monitored</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Events Today
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.depegEventsToday}</p>
          <p className="text-xs text-muted-foreground">{deltaLabel}</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-orange-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Worst Current
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats.worstCurrent ? (
            <>
              <p className="text-2xl font-bold font-mono tabular-nums">{Math.abs(stats.worstCurrent.bps)} bps</p>
              <p className="text-xs text-muted-foreground">{stats.worstCurrent.symbol}</p>
            </>
          ) : (
            <>
              <p className="text-2xl font-bold font-mono tabular-nums">0 bps</p>
              <p className="text-xs text-muted-foreground">all healthy</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
