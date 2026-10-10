"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BlacklistMetricCardSkeletonGrid } from "@/components/blacklist-metric-card-skeleton-grid";
import { InteractiveMetricStatCard, MetricStatCard } from "@/components/metric-stat-card";
import { QueryStateNotice } from "@/components/query-state-notice";
import { cn } from "@/lib/utils";
import { resolveQueryViewState } from "@/lib/query-view-state";
import type { BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import { computeFreezableSummary } from "@/components/freezewatch/freezable-supply-meter";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";
import { formatBlacklistValuation } from "@/lib/blacklist-valuation";

interface BlacklistStatsProps {
  summary: BlacklistSummaryResponse | undefined;
  isLoading: boolean;
  error?: unknown;
  blacklistStatusBuckets: BlacklistStatusBucket[] | null;
  supportDataLoading: boolean;
  supportError?: unknown;
  onRetry?: () => void;
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
  error,
  blacklistStatusBuckets,
  supportDataLoading,
  supportError,
  onRetry,
  onUnfreezableSelect,
}: BlacklistStatsProps) {
  const summaryState = resolveQueryViewState({ hasData: summary !== undefined, isLoading, error });
  const supportState = resolveQueryViewState({
    hasData: blacklistStatusBuckets !== null,
    isLoading: supportDataLoading,
    error: supportError,
  });
  const summaryUnavailable = summaryState === "unavailable";
  const supportUnavailable = supportState === "unavailable";
  const stats = summary?.stats;
  const dataQuality = summary?.dataQuality;
  const trackedFrozenTotal = stats ? (stats.trackedFrozenTotal ?? stats.activeFrozenTotal ?? 0) : null;
  const freezableSummary = computeFreezableSummary(blacklistStatusBuckets);
  const totalTrackedMarketCap = freezableSummary.totalMarketCap;
  const unfreezableBucket = blacklistStatusBuckets?.find((bucket) => bucket.key === "no") ?? null;
  // Shares divide by observed supply only; a bucket or market with no observed supply has no share.
  const unfreezableSupplyObserved =
    unfreezableBucket !== null && unfreezableBucket.supplyUnavailableCount < unfreezableBucket.count;
  const unfreezableMarketSharePct =
    unfreezableBucket && unfreezableSupplyObserved && totalTrackedMarketCap > 0
      ? (unfreezableBucket.marketCap / totalTrackedMarketCap) * 100
      : null;
  const isUnfreezableShareLoading = supportDataLoading;
  const unfreezableSharePartial = freezableSummary.coverage === "partial";
  // The headline share is published only over complete supply coverage; a partial
  // denominator moves the observed-only share into the labelled subtext.
  const unfreezableMarketShareValue =
    isUnfreezableShareLoading || supportUnavailable || unfreezableMarketSharePct === null
      ? "—"
      : unfreezableSharePartial
        ? "Partial"
        : formatMarketSharePercentage(unfreezableMarketSharePct);
  const unfreezableCount = isUnfreezableShareLoading ? "syncing" : `${unfreezableBucket?.count ?? 0} stablecoins`;
  const baseUnfreezableSubtext = supportUnavailable
    ? "Freeze status data unavailable"
    : unfreezableBucket && unfreezableMarketSharePct !== null
      ? unfreezableSharePartial
        ? `${unfreezableCount} · ${formatMarketSharePercentage(unfreezableMarketSharePct)} of observed supply (${formatCurrency(unfreezableBucket.marketCap)} of ${formatCurrency(totalTrackedMarketCap)}) · ${freezableSummary.supplyUnavailableCount} without supply data excluded`
        : `${unfreezableCount} · ${formatCurrency(unfreezableBucket.marketCap)} of ${formatCurrency(totalTrackedMarketCap)} total`
      : freezableSummary.coverage === "unavailable" && blacklistStatusBuckets !== null
        ? `${unfreezableCount} · supply data unavailable`
        : "Freezable: No / total market cap";
  const canDrillIntoUnfreezable =
    typeof onUnfreezableSelect === "function" &&
    !isUnfreezableShareLoading &&
    !supportUnavailable &&
    (unfreezableBucket?.count ?? 0) > 0;
  const unfreezableMarketShareSubtext = canDrillIntoUnfreezable
    ? `${baseUnfreezableSubtext} · View list →`
    : baseUnfreezableSubtext;
  const ambiguousOrderCount = dataQuality?.ambiguousOrderCount ?? 0;
  const hasFreezeLedgerWarnings =
    dataQuality &&
    (dataQuality.status !== "ok" || dataQuality.freezeLedger.providerFailedCount > 0 || ambiguousOrderCount > 0);
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
      {summaryUnavailable ? (
        <div className="sm:col-span-2">
          <QueryStateNotice state="unavailable" label="Freeze ledger data" onRetry={onRetry} />
        </div>
      ) : null}
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
              {dataQuality.freezeLedger.trackedGapCount > 0 ? (
                <li>{dataQuality.freezeLedger.trackedGapCount} tracked ledger gaps</li>
              ) : null}
              {dataQuality.amountGaps.recoverable > 0 ? (
                <li>
                  {dataQuality.amountGaps.recoverable} recoverable amount gaps across freeze events
                </li>
              ) : null}
              {ambiguousOrderCount > 0 ? (
                <li>
                  {ambiguousOrderCount} {ambiguousOrderCount === 1 ? "event has" : "events have"} an ambiguous order
                  {dataQuality.ambiguousOrderReason === "tron-cross-transaction-order"
                    ? " (Tron transfers in separate transactions whose relative order cannot be confirmed)"
                    : ""}{" "}
                  and {ambiguousOrderCount === 1 ? "is" : "are"} excluded from confirmed frozen counts
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
        value={trackedFrozenTotal === null ? "—" : formatCurrency(trackedFrozenTotal)}
        subtext="last-known freeze snapshots"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
      <MetricStatCard
        title="Total Wiped Value"
        value={stats ? formatBlacklistValuation(stats.destroyedTotal, stats.valuationCoverage?.destroyed) : "—"}
        subtext="destroyed or confiscated value"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
    </div>
  );
}
