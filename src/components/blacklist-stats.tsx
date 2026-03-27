"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

interface BlacklistStatsProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

export function BlacklistStats({ stats, isLoading }: BlacklistStatsProps) {
  const trackedAddressCount = stats?.trackedAddressCount ?? stats?.activeAddressCount ?? 0;
  const trackedAmountGapCount = stats?.trackedAmountGapCount ?? stats?.activeAmountGapCount ?? 0;
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="rounded-xl">
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
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-6 animate-in fade-in duration-300">
      <MetricStatCard
        borderColorClass="border-l-blue-500"
        title="USDC Blacklisted"
        value={stats?.usdcBlacklisted ?? 0}
        subtext="unique addresses"
      />
      <MetricStatCard
        borderColorClass="border-l-cyan-500"
        title="USDT Blacklisted"
        value={stats?.usdtBlacklisted ?? 0}
        subtext="unique addresses"
      />
      <MetricStatCard
        borderColorClass="border-l-emerald-500"
        title="Freeze Ledger"
        value={trackedAddressCount}
        subtext={`${trackedAmountGapCount} snapshot gaps`}
      />
      <MetricStatCard
        borderColorClass="border-l-yellow-500"
        title="Gold Frozen"
        value={stats?.goldBlacklisted ?? 0}
        subtext="PAXG / XAUT addresses"
      />
      <MetricStatCard
        borderColorClass="border-l-amber-500"
        title="Tracked Frozen Total"
        value={formatCurrency(trackedFrozenTotal)}
        subtext="persistent freeze ledger"
      />
      <MetricStatCard
        borderColorClass="border-l-red-500"
        title="Total Destroyed Funds"
        value={stats ? formatCurrency(stats.destroyedTotal) : "$0"}
        subtext="seized & burned (USD value)"
      />
    </div>
  );
}
