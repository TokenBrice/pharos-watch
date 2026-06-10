"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { MethodologyLabel } from "@/components/methodology-hint";
import type { PegSummaryStats } from "@shared/types";

export interface ActiveDepegCoin {
  id: string;
  symbol: string;
}

interface DepegTrackerStatsProps {
  stats: PegSummaryStats;
  activeDepegCoins?: ActiveDepegCoin[];
  logos?: Record<string, string>;
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

/** Overlapping logo cluster of the coins currently in an active depeg — fills the hero space. */
function DepegLogoStack({
  coins,
  logos,
}: {
  coins: ActiveDepegCoin[];
  logos?: Record<string, string>;
}) {
  if (coins.length === 0) return null;
  return (
    <div
      className="hidden min-w-0 items-center justify-end sm:flex"
      role="img"
      aria-label={`Currently off peg: ${coins.map((c) => c.symbol).join(", ")}`}
    >
      <div className="flex flex-wrap justify-end -space-x-4">
        {coins.map((coin) => (
          <span
            key={coin.id}
            title={coin.symbol}
            className="inline-flex rounded-full ring-2 ring-card"
          >
            <StablecoinLogo src={logos?.[coin.id]} name={coin.symbol} size={36} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Compact peg-health tile: big number with a tight inline-ish label. */
function PegStat({
  title,
  value,
  subtext,
}: {
  title: ReactNode;
  value: ReactNode;
  subtext: string;
}) {
  return (
    <div className="pharos-card-shell rounded-xl px-4 py-3">
      <p className="pharos-kicker">{title}</p>
      <p className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold tabular-nums leading-none">{value}</span>
        <span className="text-xs text-muted-foreground">{subtext}</span>
      </p>
    </div>
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
      {trail ? <span className="text-muted-foreground/70"> {trail}</span> : null}
    </span>
  );
}

export function DepegTrackerStats({ stats, activeDepegCoins = [], logos }: DepegTrackerStatsProps) {
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
        <div className="flex items-center justify-between gap-3">
          <div className="shrink-0">
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
          <div className="flex min-w-0 items-center justify-end gap-3">
            <DepegLogoStack coins={activeDepegCoins} logos={logos} />
            <ActiveStatusPill active={hasActive} />
          </div>
        </div>
      </Card>

      {/* Tier 2 — peg health: how much of the tracked set is holding? */}
      <div className="grid grid-cols-2 gap-3">
        <PegStat
          title={<MethodologyLabel topic="coinsAtPeg">Coins at Peg</MethodologyLabel>}
          value={stats.coinsAtPeg}
          subtext="holding peg now"
        />
        <PegStat title="Peg Monitored" value={stats.totalTracked} subtext="with live peg status" />
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
