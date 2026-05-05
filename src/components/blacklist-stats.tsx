"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
import { BLACKLIST_STATUS_BUCKET_COLORS, type BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import type { ApiMeta } from "@/lib/api";
import { formatCurrency, formatElapsedSeconds, formatPercent, timeAgo } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

interface BlacklistStatsProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  summary?: BlacklistSummaryResponse;
  freshnessMeta?: ApiMeta | null;
  isLoading: boolean;
  blacklistStatusBuckets: BlacklistStatusBucket[] | null;
  supportDataLoading: boolean;
}

interface BlacklistFreezeLedgerMeta {
  oldestObservedAt?: number | null;
  newestObservedAt?: number | null;
  providerFailedCount?: number | null;
  staleSnapshotCount?: number | null;
  statusCounts?: Record<string, number> | null;
  statusDistribution?: Record<string, number> | null;
  sourceCounts?: Record<string, number> | null;
  sourceDistribution?: Record<string, number> | null;
  gapCounts?: {
    tracked?: number | null;
    recoverable?: number | null;
    unrecoverable?: number | null;
    providerFailed?: number | null;
  } | null;
  gaps?: {
    tracked?: number | null;
    recoverable?: number | null;
    unrecoverable?: number | null;
    recentRecoverable?: number | null;
    repeatedFailures?: number | null;
  } | null;
  freshnessDistribution?: {
    fresh?: number;
    degraded?: number;
    stale?: number;
  } | null;
}

interface BlacklistCoverageMeta {
  unsupported?: unknown[] | Record<string, unknown> | null;
  deferred?: unknown[] | Record<string, unknown> | null;
  unsupportedDeferred?: unknown[] | Record<string, unknown> | null;
  counts?: {
    unsupportedDeferredConfigs?: number | null;
  } | null;
}

interface BlacklistDataQualityMeta {
  freezeLedger?: {
    providerFailedCount?: number | null;
    staleSnapshotCount?: number | null;
    trackedGapCount?: number | null;
  } | null;
  coverage?: {
    unsupportedDeferredConfigs?: number | null;
  } | null;
}

type BlacklistSummaryWithQuality = BlacklistSummaryResponse & {
  freezeLedgerMeta?: BlacklistFreezeLedgerMeta | null;
  coverage?: BlacklistCoverageMeta | null;
  dataQuality?: BlacklistDataQualityMeta | null;
};

function formatMarketSharePercentage(value: number): string {
  if (value < 0.1) return formatPercent(value, 3);
  if (value < 1) return formatPercent(value, 2);
  return formatPercent(value, 1);
}

function countMetaEntries(value: unknown[] | Record<string, unknown> | null | undefined): number {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  return Object.keys(value).length;
}

function readCount(record: Record<string, number> | null | undefined, keys: readonly string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function BlacklistStats({
  stats,
  summary,
  freshnessMeta,
  isLoading,
  blacklistStatusBuckets,
  supportDataLoading,
}: BlacklistStatsProps) {
  const trackedFrozenTotal = stats?.trackedFrozenTotal ?? stats?.activeFrozenTotal ?? 0;
  const quality = summary as BlacklistSummaryWithQuality | undefined;
  const freezeLedgerMeta = quality?.freezeLedgerMeta ?? null;
  const statusCounts = freezeLedgerMeta?.statusCounts ?? freezeLedgerMeta?.statusDistribution ?? null;
  const providerFailedCount =
    quality?.dataQuality?.freezeLedger?.providerFailedCount
      ?? freezeLedgerMeta?.providerFailedCount
      ?? freezeLedgerMeta?.gapCounts?.providerFailed
      ?? readCount(statusCounts, ["provider_failed", "providerFailed"]);
  const staleSnapshotCount =
    quality?.dataQuality?.freezeLedger?.staleSnapshotCount
      ?? freezeLedgerMeta?.staleSnapshotCount
      ?? freezeLedgerMeta?.freshnessDistribution?.stale
      ?? readCount(statusCounts, ["stale", "stale_snapshot", "staleSnapshot"]);
  const trackedGapCount =
    quality?.dataQuality?.freezeLedger?.trackedGapCount
      ?? freezeLedgerMeta?.gaps?.tracked
      ?? freezeLedgerMeta?.gapCounts?.tracked
      ?? stats?.trackedAmountGapCount
      ?? 0;
  const recoverableGapCount =
    freezeLedgerMeta?.gaps?.recoverable ?? freezeLedgerMeta?.gapCounts?.recoverable ?? stats?.recoverableGapCount ?? 0;
  const coverageGapCount =
    quality?.dataQuality?.coverage?.unsupportedDeferredConfigs
      ?? quality?.coverage?.counts?.unsupportedDeferredConfigs
      ?? (
        countMetaEntries(quality?.coverage?.unsupported)
        + countMetaEntries(quality?.coverage?.deferred)
        + countMetaEntries(quality?.coverage?.unsupportedDeferred)
      );
  const snapshotAgeLabel = freezeLedgerMeta?.newestObservedAt
    ? timeAgo(freezeLedgerMeta.newestObservedAt)
    : freshnessMeta?.ageSeconds != null
      ? `${formatElapsedSeconds(freshnessMeta.ageSeconds)} sync age`
      : "pending";
  const snapshotAgeSubtext = freezeLedgerMeta?.newestObservedAt
    ? `newest observed ${new Date(freezeLedgerMeta.newestObservedAt * 1000).toLocaleDateString("en-US")}`
    : "using blacklist sync freshness";
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
    <div className="space-y-3 animate-in fade-in duration-300">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
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
          subtext="last-known freeze snapshots"
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
      <div className="grid gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="font-medium text-foreground">Snapshot Basis</p>
          <p className="mt-1 text-muted-foreground">Last-known successful reads; new rows are contract/config scoped.</p>
        </div>
        <div>
          <p className="font-medium text-foreground">Snapshot Age</p>
          <p className="mt-1 font-mono tabular-nums text-muted-foreground">{snapshotAgeLabel}</p>
          <p className="mt-0.5 text-muted-foreground">{snapshotAgeSubtext}</p>
        </div>
        <div>
          <p className="font-medium text-foreground">Amount Gaps</p>
          <p className="mt-1 font-mono tabular-nums text-muted-foreground">
            {recoverableGapCount} event / {trackedGapCount} ledger
          </p>
          <p className="mt-0.5 text-muted-foreground">Recoverable rows stay visible until remediation resolves them.</p>
        </div>
        <div>
          <p className="font-medium text-foreground">Data Quality</p>
          <p className="mt-1 font-mono tabular-nums text-muted-foreground">
            {providerFailedCount} provider failed / {staleSnapshotCount} stale / {coverageGapCount} deferred
          </p>
          <p className="mt-0.5 text-muted-foreground">Provider failures preserve the last successful snapshot value.</p>
        </div>
      </div>
    </div>
  );
}
