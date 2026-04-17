"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency } from "@shared/lib/format";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

interface BlacklistStatsProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
  showLegacyTriples?: boolean;
}

export function BlacklistStats({ stats, isLoading, showLegacyTriples = false }: BlacklistStatsProps) {
  const trackedAddressCount = stats?.trackedAddressCount ?? stats?.activeAddressCount ?? 0;
  const trackedAmountGapCount = stats?.trackedAmountGapCount ?? stats?.activeAmountGapCount ?? 0;
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;

  const topByCount = stats?.perCoinBlacklistCounts
    ? (Object.entries(stats.perCoinBlacklistCounts) as [BlacklistStablecoin, number][])
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
    : [];

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
    <div className="flex flex-col gap-3 sm:gap-5 animate-in fade-in duration-300">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {topByCount.map(([coin, count]) => (
          <MetricStatCard
            key={coin}
            borderColorClass="border-border"
            borderColorHex={BLACKLIST_CHART_COLORS[coin]}
            title={`${coin} Blacklisted`}
            value={count}
            subtext="unique events"
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3">
        {showLegacyTriples ? (
          <>
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
              borderColorClass="border-l-yellow-500"
              title="Gold Frozen"
              value={stats?.goldBlacklisted ?? 0}
              subtext="PAXG / XAUT addresses"
            />
          </>
        ) : null}
        <MetricStatCard
          borderColorClass="border-l-emerald-500"
          title="Freeze Ledger"
          value={trackedAddressCount}
          subtext={`${trackedAmountGapCount} snapshot gaps`}
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
    </div>
  );
}
