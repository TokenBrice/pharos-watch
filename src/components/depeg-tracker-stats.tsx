"use client";

import { MetricStatCard } from "@/components/metric-stat-card";
import type { PegSummaryStats } from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";

interface DepegTrackerStatsProps {
  stats: PegSummaryStats;
}

export function DepegTrackerStats({ stats }: DepegTrackerStatsProps) {
  const eventDelta = stats.depegEventsToday - stats.depegEventsYesterday;
  const deltaLabel =
    eventDelta > 0 ? `+${eventDelta} vs yesterday` :
    eventDelta < 0 ? `${eventDelta} vs yesterday` :
    "same as yesterday";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <MetricStatCard
        title={<MethodologyLabel topic="activeDepegs">Active Depegs</MethodologyLabel>}
        value={stats.activeDepegCount}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext="ongoing events"
      />

      <MetricStatCard
        title={<MethodologyLabel topic="coinsAtPeg">Coins at Peg</MethodologyLabel>}
        value={stats.coinsAtPeg}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext={`of ${stats.totalTracked} with live peg status`}
      />

      <MetricStatCard
        title={<MethodologyLabel topic="medianDeviation">Median Deviation</MethodologyLabel>}
        value={`${stats.medianDeviationBps} bps`}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext="across live peg-status rows"
      />

      <MetricStatCard
        title="Peg Monitored"
        value={stats.totalTracked}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext="with live peg status"
      />

      <MetricStatCard
        title="Events Today"
        value={stats.depegEventsToday}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext={deltaLabel}
      />

      <MetricStatCard
        title={<MethodologyLabel topic="worstCurrentDeviation">Worst Current</MethodologyLabel>}
        value={stats.worstCurrent ? `${Math.abs(stats.worstCurrent.bps)} bps` : "0 bps"}
        valueClassName="text-2xl font-bold font-mono tabular-nums"
        subtext={stats.worstCurrent?.symbol ?? "all healthy"}
      />
    </div>
  );
}
