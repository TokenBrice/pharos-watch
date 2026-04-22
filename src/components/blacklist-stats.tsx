"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { BLACKLIST_STATUS_BUCKET_COLORS, type BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

interface BlacklistStatsProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
  blacklistStatusBuckets: BlacklistStatusBucket[] | null;
  supportDataLoading: boolean;
}

function formatMarketSharePercentage(value: number): string {
  if (value < 0.1) return formatPercent(value, 3);
  if (value < 1) return formatPercent(value, 2);
  return formatPercent(value, 1);
}

export function BlacklistStats({
  stats,
  isLoading,
  blacklistStatusBuckets,
  supportDataLoading,
}: BlacklistStatsProps) {
  const trackedAddressCount = stats?.trackedAddressCount ?? stats?.activeAddressCount ?? 0;
  const trackedAmountGapCount = stats?.trackedAmountGapCount ?? stats?.activeAmountGapCount ?? 0;
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;
  const totalTrackedMarketCap = (blacklistStatusBuckets ?? []).reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const unfreezableBucket = blacklistStatusBuckets?.find((bucket) => bucket.key === "no") ?? null;
  const unfreezableMarketSharePct =
    unfreezableBucket && totalTrackedMarketCap > 0
      ? (unfreezableBucket.marketCap / totalTrackedMarketCap) * 100
      : 0;
  const isUnfreezableShareLoading = supportDataLoading;
  const unfreezableMarketShareValue = isUnfreezableShareLoading ? "—" : formatMarketSharePercentage(unfreezableMarketSharePct);
  const unfreezableMarketShareSubtext =
    unfreezableBucket && totalTrackedMarketCap > 0
      ? `${formatCurrency(unfreezableBucket.marketCap)} of ${formatCurrency(totalTrackedMarketCap)} total`
      : "blacklist status: no / total market cap";

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
      <div className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-4">
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
        <MetricStatCard
          borderColorClass="border-border"
          borderColorHex={BLACKLIST_STATUS_BUCKET_COLORS.no}
          title="Unfreezable Market Share"
          value={unfreezableMarketShareValue}
          subtext={unfreezableMarketShareSubtext}
        />
      </div>
    </div>
  );
}
