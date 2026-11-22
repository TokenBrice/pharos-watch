"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BlacklistMetricCardSkeletonGrid } from "@/components/freezewatch/blacklist-metric-card-skeleton-grid";
import { MetricStatCard } from "@/components/metric-stat-card";
import { QueryStateNotice } from "@/components/query-state-notice";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types/blacklist";
import { formatBlacklistValuation } from "@/lib/blacklist-valuation";

interface BlacklistStatsProps {
  summary: BlacklistSummaryResponse | undefined;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
}

export function BlacklistStats({
  summary,
  isLoading,
  error,
  onRetry,
}: BlacklistStatsProps) {
  const summaryState = resolveQueryViewState({ hasData: summary !== undefined, isLoading, error });
  const summaryUnavailable = summaryState === "unavailable";
  const stats = summary?.stats;
  const dataQuality = summary?.dataQuality;
  const ambiguousOrderCount = dataQuality?.ambiguousOrderCount ?? 0;
  // Only material staleness is a reader notice; degraded ledger checks are operator signal.
  const hasFreezeLedgerWarnings = dataQuality?.status === "stale";

  if (isLoading) {
    return (
      <BlacklistMetricCardSkeletonGrid
        gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5"
        cardClassName="rounded-xl"
        count={2}
      />
    );
  }

  return (
    <section
      aria-label="Observed freeze enforcement"
      className="grid grid-cols-1 gap-3 animate-in fade-in duration-300 sm:grid-cols-2 sm:gap-5"
    >
      {summaryUnavailable ? (
        <div className="sm:col-span-2">
          <QueryStateNotice state="unavailable" label="Freeze ledger data" onRetry={onRetry} />
        </div>
      ) : null}
      {hasFreezeLedgerWarnings ? (
        <Card
          className="pharos-card-shell border-l-[3px] border-l-state-warn-solid/70 sm:col-span-2"
          role="status"
        >
          <CardHeader className="pb-2">
            <p className="pharos-label">Data quality</p>
            <h3 className="text-sm font-semibold text-foreground">Freeze ledger coverage is stale</h3>
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
      <MetricStatCard
        title="Tracked frozen total"
        value={
          stats
            ? formatBlacklistValuation(stats.trackedFrozenTotal, {
                knownCount: stats.trackedAddressCount - stats.trackedAmountGapCount,
                unavailableCount: stats.trackedAmountGapCount,
              }, formatCurrency, { markPartial: false })
            : "—"
        }
        subtext="last-known freeze snapshots"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
      <MetricStatCard
        title="Total wiped value"
        value={stats
          ? formatBlacklistValuation(stats.destroyedTotal, stats.valuationCoverage?.destroyed, formatCurrency, { markPartial: false })
          : "—"}
        subtext="destroyed or confiscated value"
        valueClassName="pharos-numeric text-3xl font-semibold"
        subtextClassName="text-sm text-muted-foreground"
      />
    </section>
  );
}
