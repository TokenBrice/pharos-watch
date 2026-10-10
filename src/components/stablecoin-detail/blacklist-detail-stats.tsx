"use client";

import { MetricStatCard } from "@/components/metric-stat-card";
import { BlacklistMetricCardSkeletonGrid } from "@/components/blacklist-metric-card-skeleton-grid";
import { formatBlacklistValuation } from "@/lib/blacklist-valuation";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

interface BlacklistDetailStatsProps {
  symbol: BlacklistStablecoin;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

export function BlacklistDetailStats({ symbol, stats, isLoading }: BlacklistDetailStatsProps) {
  if (isLoading || !stats) {
    return (
      <BlacklistMetricCardSkeletonGrid
        gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5"
        cardClassName="pharos-card-shell"
      />
    );
  }

  const frozenAddresses = stats.perCoinFrozenAddressCount[symbol] ?? 0;
  const frozenTotal = stats.perCoinFrozenTotal[symbol];
  const destroyedTotal = stats.perCoinDestroyedTotal[symbol];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
      <MetricStatCard
        title="Frozen addresses"
        value={frozenAddresses}
        subtext="net-frozen (latest action is blacklist)"
      />
      <MetricStatCard
        title="Frozen total"
        value={formatBlacklistValuation(frozenTotal, stats.valuationCoverage?.perCoinFrozen[symbol])}
        subtext="persistent freeze-ledger balance"
      />
      <MetricStatCard
        title="Destroyed"
        value={formatBlacklistValuation(destroyedTotal, stats.valuationCoverage?.perCoinDestroyed[symbol])}
        subtext="seized &amp; burned (USD value)"
      />
    </div>
  );
}
