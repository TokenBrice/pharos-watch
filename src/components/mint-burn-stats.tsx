"use client";

import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import type { MintBurnEvent } from "@/lib/types";

interface MintBurnStatsProps {
  events: MintBurnEvent[] | undefined;
  isLoading: boolean;
}

interface Stats {
  totalMinted: number;
  totalBurned: number;
  netFlow: number;
  recentCount: number;
  usdcMinted: number;
  usdtMinted: number;
}

function computeStats(events: MintBurnEvent[]): Stats {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  let totalMinted = 0;
  let totalBurned = 0;
  let recentCount = 0;
  let usdcMinted = 0;
  let usdtMinted = 0;

  for (const evt of events) {
    if (evt.eventType === "mint") {
      totalMinted += evt.amount;
      if (evt.stablecoin === "USDC") usdcMinted += evt.amount;
      if (evt.stablecoin === "USDT") usdtMinted += evt.amount;
    } else {
      totalBurned += evt.amount;
    }
    if (evt.timestamp >= thirtyDaysAgo) recentCount++;
  }

  return {
    totalMinted,
    totalBurned,
    netFlow: totalMinted - totalBurned,
    recentCount,
    usdcMinted,
    usdtMinted,
  };
}

export function MintBurnStats({ events, isLoading }: MintBurnStatsProps) {
  const stats = useMemo(() => {
    if (!events) return null;
    return computeStats(events);
  }, [events]);

  if (isLoading) {
    return (
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="rounded-2xl">
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
      <Card className="rounded-2xl border-l-[3px] border-l-emerald-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Minted</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold font-mono">{stats ? formatCurrency(stats.totalMinted) : "$0"}</p>
          <p className="text-xs text-muted-foreground">all-time issuance</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Burned</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold font-mono">{stats ? formatCurrency(stats.totalBurned) : "$0"}</p>
          <p className="text-xs text-muted-foreground">all-time redemptions</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Flow</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold font-mono">{stats ? formatCurrency(stats.netFlow) : "$0"}</p>
          <p className="text-xs text-muted-foreground">minted &minus; burned</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">USDC vs USDT</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold font-mono">{stats ? `${((stats.usdcMinted / (stats.totalMinted || 1)) * 100).toFixed(0)}%` : "0%"}</p>
          <p className="text-xs text-muted-foreground">USDC share of mints</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Events</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold font-mono">{stats?.recentCount ?? 0}</p>
          <p className="text-xs text-muted-foreground">last 30 days</p>
        </CardContent>
      </Card>
    </div>
  );
}
