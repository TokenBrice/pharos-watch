"use client";

import { MetricStatCard } from "@/components/metric-stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

interface BlacklistDetailStatsProps {
  symbol: BlacklistStablecoin;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

export function BlacklistDetailStats({ symbol, stats, isLoading }: BlacklistDetailStatsProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="pharos-card-shell">
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

  const frozenAddresses = stats.perCoinFrozenAddressCount[symbol] ?? 0;
  const frozenTotal = stats.perCoinFrozenTotal[symbol] ?? 0;
  const destroyedTotal = stats.perCoinDestroyedTotal[symbol] ?? 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
      <MetricStatCard
        title="Frozen addresses"
        value={frozenAddresses}
        subtext="net-frozen (latest action is blacklist)"
      />
      <MetricStatCard
        title="Frozen total"
        value={formatCurrency(frozenTotal)}
        subtext="persistent freeze-ledger balance"
      />
      <MetricStatCard
        title="Destroyed"
        value={formatCurrency(destroyedTotal)}
        subtext="seized &amp; burned (USD value)"
      />
    </div>
  );
}
