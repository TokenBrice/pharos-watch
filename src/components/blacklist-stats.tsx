"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BlacklistMetricCardSkeletonGrid } from "@/components/blacklist-metric-card-skeleton-grid";
import { InteractiveMetricStatCard, MetricStatCard } from "@/components/metric-stat-card";
import { cn } from "@/lib/utils";
import type { BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

interface BlacklistStatsProps {
  summary: BlacklistSummaryResponse | undefined;
  isLoading: boolean;
  blacklistStatusBuckets: BlacklistStatusBucket[] | null;
  supportDataLoading: boolean;
  onUnfreezableSelect?: () => void;
}

function formatMarketSharePercentage(value: number): string {
  if (value < 0.1) return formatPercent(value, 3);
  if (value < 1) return formatPercent(value, 2);
  return formatPercent(value, 1);
}

export function BlacklistStats({
  summary,
  isLoading,
  blacklistStatusBuckets,
  supportDataLoading,
  onUnfreezableSelect,
}: BlacklistStatsProps) {
  const stats = summary?.stats;
  const dataQuality = summary?.dataQuality;
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;
  const totalTrackedMarketCap = (blacklistStatusBuckets ?? []).reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const unfreezableBucket = blacklistStatusBuckets?.find((bucket) => bucket.key === "no") ?? null;
  const unfreezableMarketSharePct =
    unfreezableBucket && totalTrackedMarketCap > 0 ? (unfreezableBucket.marketCap / totalTrackedMarketCap) * 100 : 0;
  const isUnfreezableShareLoading = supportDataLoading;
  const unfreezableMarketShareValue = isUnfreezableShareLoading
    ? "—"
    : formatMarketSharePercentage(unfreezableMarketSharePct);
  const unfreezableCount = isUnfreezableShareLoading ? "syncing" : `${unfreezableBucket?.count ?? 0} stablecoins`;
  const baseUnfreezableSubtext =
    unfreezableBucket && totalTrackedMarketCap > 0
      ? `${unfreezableCount} · ${formatCurrency(unfreezableBucket.marketCap)} of ${formatCurrency(totalTrackedMarketCap)} total`
      : "Freezable: No / total market cap";
  const canDrillIntoUnfreezable =
    typeof onUnfreezableSelect === "function" && !isUnfreezableShareLoading && (unfreezableBucket?.count ?? 0) > 0;
  const unfreezableMarketShareSubtext = canDrillIntoUnfreezable
    ? `${baseUnfreezableSubtext} · View list →`
    : baseUnfreezableSubtext;
  const hasFreezeLedgerWarnings =
    dataQuality &&
    (dataQuality.status !== "ok" ||
      dataQuality.freezeLedger.providerFailedCount > 0 ||
      dataQuality.freezeLedger.staleSnapshotCount > 0);
  const qualityTone = dataQuality?.status === "stale" ? "stale" : "degraded";
  const qualityTitle =
    dataQuality?.status === "stale" ? "Freeze ledger coverage is stale" : "Freeze ledger coverage is degraded";

  if (isLoading) {
    return (
      <BlacklistMetricCardSkeletonGrid
        gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5"
        cardClassName="rounded-xl"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300 sm:grid-cols-2 sm:gap-5">
      {hasFreezeLedgerWarnings ? (
        <Card
          className={cn(
            "pharos-card-shell border-l-[3px] sm:col-span-2",
            qualityTone === "stale" ? "border-l-amber-500/70" : "border-l-orange-500/70",
          )}
          role="status"
        >
          <CardHeader className="pb-2">
            <p className="pharos-kicker">Data Quality</p>
            <h3 className="text-sm font-semibold text-foreground">{qualityTitle}</h3>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Tracked frozen totals use last-known freeze snapshots. Treat the exposure figures as provisional until the
              freeze-ledger checks recover.
            </p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {dataQuality.freezeLedger.providerFailedCount > 0 ? (
                <li>{dataQuality.freezeLedger.providerFailedCount} current-balance provider failures</li>
              ) : null}
              {dataQuality.freezeLedger.staleSnapshotCount > 0 ? (
                <li>{dataQuality.freezeLedger.staleSnapshotCount} stale current-balance snapshots</li>
              ) : null}
              {dataQuality.freezeLedger.trackedGapCount > 0 ? (
                <li>{dataQuality.freezeLedger.trackedGapCount} tracked ledger gaps</li>
              ) : null}
              {dataQuality.amountGaps.recoverable > 0 ? (
                <li>
                  {dataQuality.amountGaps.recoverable} recoverable amount gaps across freeze events
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {canDrillIntoUnfreezable && onUnfreezableSelect ? (
        <InteractiveMetricStatCard
          title="Unfreezable Market Share"
          value={unfreezableMarketShareValue}
          subtext={unfreezableMarketShareSubtext}
          className="sm:col-span-2"
          onClick={onUnfreezableSelect}
          actionLabel="Show unfreezable stablecoins"
        />
      ) : (
        <MetricStatCard
          title="Unfreezable Market Share"
          value={unfreezableMarketShareValue}
          subtext={unfreezableMarketShareSubtext}
          variant="hero"
          className="sm:col-span-2"
        />
      )}
      <MetricStatCard
        title="Tracked Frozen Total"
        value={formatCurrency(trackedFrozenTotal)}
        subtext="last-known freeze snapshots"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
      <MetricStatCard
        title="Total Wiped Value"
        value={stats ? formatCurrency(stats.destroyedTotal) : "$0"}
        subtext="destroyed or confiscated value"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
    </div>
  );
}
