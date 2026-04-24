"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { BLACKLIST_STATUS_BUCKET_COLORS, type BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

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
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;
  const totalTrackedMarketCap = (blacklistStatusBuckets ?? []).reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const unfreezableBucket = blacklistStatusBuckets?.find((bucket) => bucket.key === "no") ?? null;
  const unfreezableMarketSharePct =
    unfreezableBucket && totalTrackedMarketCap > 0
      ? (unfreezableBucket.marketCap / totalTrackedMarketCap) * 100
      : 0;
  const isUnfreezableShareLoading = supportDataLoading;
  const unfreezableMarketShareValue = isUnfreezableShareLoading ? "—" : formatMarketSharePercentage(unfreezableMarketSharePct);
  const unfreezableCount = isUnfreezableShareLoading ? "syncing" : `${unfreezableBucket?.count ?? 0} stablecoins`;
  const unfreezableMarketShareSubtext =
    unfreezableBucket && totalTrackedMarketCap > 0
      ? `${unfreezableCount} · ${formatCurrency(unfreezableBucket.marketCap)} of ${formatCurrency(totalTrackedMarketCap)} total`
      : "blacklist status: no / total market cap";

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4 animate-in fade-in duration-300">
      <MetricStatCard
        borderColorClass="border-border"
        borderColorHex={BLACKLIST_STATUS_BUCKET_COLORS.no}
        title="Unfreezable Market Share"
        value={unfreezableMarketShareValue}
        subtext={unfreezableMarketShareSubtext}
        className="sm:col-span-2 xl:col-span-2"
        contentClassName="pt-1"
        valueClassName="text-4xl font-black leading-none sm:text-5xl"
        subtextClassName="mt-2 text-sm text-muted-foreground"
      />
      <MetricStatCard
        borderColorClass="border-l-amber-500"
        title="Tracked Frozen Total"
        value={formatCurrency(trackedFrozenTotal)}
        subtext="persistent freeze ledger"
        valueClassName="text-3xl font-black"
        subtextClassName="text-sm text-muted-foreground"
      />
      <MetricStatCard
        borderColorClass="border-l-red-500"
        title="Total Destroyed Funds"
        value={stats ? formatCurrency(stats.destroyedTotal) : "$0"}
        subtext="seized & burned (USD value)"
        valueClassName="text-3xl font-black"
        subtextClassName="text-sm text-muted-foreground"
      />
    </div>
  );
}
