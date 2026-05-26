"use client";

import { Card } from "@/components/ui/card";
import { MetricStatCard } from "@/components/metric-stat-card";
import { MethodologyLabel } from "@/components/methodology-hint";
import type { PegSummaryStats } from "@shared/types";

interface DepegTrackerStatsProps {
  stats: PegSummaryStats;
}

/** Live/clear status for the Active Depegs hero — a data-driven indicator, not card chrome. */
function ActiveStatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
        live
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      clear
    </span>
  );
}

function StripStat({
  value,
  label,
  trail,
}: {
  value: string;
  label: string;
  trail?: string;
}) {
  return (
    <span className="text-xs text-muted-foreground">
      <span className="font-mono font-semibold tabular-nums text-foreground">{value}</span> {label}
      {trail ? <span className="text-muted-foreground/60"> {trail}</span> : null}
    </span>
  );
}

export function DepegTrackerStats({ stats }: DepegTrackerStatsProps) {
  const eventDelta = stats.depegEventsToday - stats.depegEventsYesterday;
  const deltaLabel =
    eventDelta > 0 ? `+${eventDelta} vs yesterday` :
    eventDelta < 0 ? `${eventDelta} vs yesterday` :
    "same as yesterday";
  const hasActive = stats.activeDepegCount > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Tier 1 — the headline: are coins actively broken right now? */}
      <Card className="rounded-xl p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="pharos-kicker">
              <MethodologyLabel topic="activeDepegs">Active Depegs</MethodologyLabel>
            </p>
            <p className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-extrabold tabular-nums leading-none">
                {stats.activeDepegCount}
              </span>
              <span className="text-sm text-muted-foreground">ongoing events</span>
            </p>
          </div>
          <ActiveStatusPill active={hasActive} />
        </div>
      </Card>

      {/* Tier 2 — peg health: how much of the tracked set is holding? */}
      <div className="grid grid-cols-2 gap-3">
        <MetricStatCard
          title={<MethodologyLabel topic="coinsAtPeg">Coins at Peg</MethodologyLabel>}
          value={stats.coinsAtPeg}
          valueClassName="text-2xl font-bold font-mono tabular-nums"
          subtext="holding peg now"
        />
        <MetricStatCard
          title="Peg Monitored"
          value={stats.totalTracked}
          valueClassName="text-2xl font-bold font-mono tabular-nums"
          subtext="with live peg status"
        />
      </div>

      {/* Tier 3 — supporting context, demoted to a single quiet line */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        <StripStat value={String(stats.depegEventsToday)} label="events today" trail={`(${deltaLabel})`} />
        <StripStat
          value={stats.worstCurrent ? `${Math.abs(stats.worstCurrent.bps)} bps` : "0 bps"}
          label="worst"
          trail={stats.worstCurrent ? `· ${stats.worstCurrent.symbol}` : undefined}
        />
        <StripStat value={`${stats.medianDeviationBps} bps`} label="median deviation" />
      </div>
    </div>
  );
}
