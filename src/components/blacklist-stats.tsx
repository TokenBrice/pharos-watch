"use client";

import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { extractGoldPrices, computeBlacklistStats } from "@/lib/blacklist-helpers";
import type { BlacklistEvent } from "@/lib/types";

interface BlacklistStatsProps {
  events: BlacklistEvent[] | undefined;
  isLoading: boolean;
}

export function BlacklistStats({ events, isLoading }: BlacklistStatsProps) {
  const { data: stablecoins } = useStablecoins();

  const goldPrices = useMemo(() => {
    if (!stablecoins) return {};
    return extractGoldPrices(stablecoins.peggedAssets);
  }, [stablecoins]);

  const stats = useMemo(() => {
    if (!events) return null;
    return computeBlacklistStats(events, goldPrices);
  }, [events, goldPrices]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-5">
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
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-5">
      <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">USDC Blacklisted</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono">{stats?.usdcBlacklisted ?? 0}</p>
          <p className="text-xs text-muted-foreground">unique addresses</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">USDT Blacklisted</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono">{stats?.usdtBlacklisted ?? 0}</p>
          <p className="text-xs text-muted-foreground">unique addresses</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-yellow-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Gold Frozen</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono">{stats?.goldBlacklisted ?? 0}</p>
          <p className="text-xs text-muted-foreground">PAXG / XAUT addresses</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Destroyed Funds</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono">{stats ? formatCurrency(stats.destroyedTotal) : "$0"}</p>
          <p className="text-xs text-muted-foreground">seized &amp; burned (USD value)</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Events</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono">{stats?.recentCount ?? 0}</p>
          <p className="text-xs text-muted-foreground">last 30 days</p>
        </CardContent>
      </Card>
    </div>
  );
}
