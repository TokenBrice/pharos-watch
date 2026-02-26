"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Droplets } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";

export function LiquiditySummary() {
  const { data, isLoading } = useDexLiquidity();

  const stats = useMemo(() => {
    if (!data) return null;
    let totalTvl = 0;
    let totalVol24h = 0;
    let activeCount = 0;
    for (const v of Object.values(data)) {
      totalTvl += v.totalTvlUsd;
      totalVol24h += v.totalVolume24hUsd;
      if (v.liquidityScore && v.liquidityScore > 0) activeCount++;
    }
    return { totalTvl, totalVol24h, activeCount };
  }, [data]);

  if (isLoading) {
    return (
      <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><Droplets className="h-4 w-4" />DEX Liquidity</span>
          <Link
            href="/liquidity"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View rankings &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-2xl font-bold font-mono">{stats ? formatCurrency(stats.totalTvl, 1) : "$0"}</p>
            <p className="text-xs text-muted-foreground">total DEX TVL</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats ? formatCurrency(stats.totalVol24h, 1) : "$0"}</p>
            <p className="text-xs text-muted-foreground">24h volume</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats?.activeCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">stablecoins on DEX</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
