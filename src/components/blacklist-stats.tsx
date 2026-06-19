"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
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
      dataQuality.warnings.length > 0 ||
      dataQuality.freezeLedger.providerFailedCount > 0 ||
      dataQuality.freezeLedger.staleSnapshotCount > 0 ||
      dataQuality.freezeLedger.trackedGapCount > 0 ||
      dataQuality.amountGaps.recoverable > 0 ||
      dataQuality.amountGaps.unrecoverable > 0 ||
      dataQuality.coverage.unsupportedDeferredConfigs > 0);
  const qualityTone = dataQuality?.status === "stale" ? "stale" : "degraded";
  const qualityTitle =
    dataQuality?.status === "stale" ? "Freeze ledger snapshots are stale" : "Freeze ledger coverage is degraded";

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5">
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
    <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300 sm:grid-cols-2 sm:gap-5">
      {hasFreezeLedgerWarnings ? (
        <Card
          className={
            qualityTone === "stale"
              ? "rounded-xl border-amber-500/60 bg-amber-500/10 sm:col-span-2"
              : "rounded-xl border-yellow-500/60 bg-yellow-500/10 sm:col-span-2"
          }
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
              {dataQuality.amountGaps.recoverable + dataQuality.amountGaps.unrecoverable > 0 ? (
                <li>
                  {dataQuality.amountGaps.recoverable + dataQuality.amountGaps.unrecoverable} amount gaps across freeze
                  events
                </li>
              ) : null}
              {dataQuality.coverage.unsupportedDeferredConfigs > 0 ? (
                <li>{dataQuality.coverage.unsupportedDeferredConfigs} deferred coverage configs</li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <MetricStatCard
        title="Unfreezable Market Share"
        value={unfreezableMarketShareValue}
        subtext={unfreezableMarketShareSubtext}
        className="sm:col-span-2"
        contentClassName="pt-1"
        valueClassName="text-4xl font-black leading-none sm:text-5xl"
        subtextClassName="mt-2 text-sm text-muted-foreground"
        onClick={canDrillIntoUnfreezable ? onUnfreezableSelect : undefined}
        actionLabel="Show unfreezable stablecoins"
      />
      <MetricStatCard
        title="Tracked Frozen Total"
        value={formatCurrency(trackedFrozenTotal)}
        subtext="last-known freeze snapshots"
        valueClassName="text-3xl font-black"
        subtextClassName="text-sm text-muted-foreground"
      />
      <MetricStatCard
        title="Total Wiped Value"
        value={stats ? formatCurrency(stats.destroyedTotal) : "$0"}
        subtext="destroyed or confiscated value"
        valueClassName="text-3xl font-black"
        subtextClassName="text-sm text-muted-foreground"
      />
    </div>
  );
}
