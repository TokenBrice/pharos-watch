"use client";

import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { getCirculatingRaw, getPrevWeekRaw } from "@/lib/supply";
import { TRACKED_STABLECOINS, TRACKED_IDS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { GOVERNANCE_TIER_COLORS, GOVERNANCE_LABELS_SHORT } from "@/lib/classification";
import type { StablecoinData, PegSummaryCoin, PegSummaryStats, BlacklistEvent, GovernanceType } from "@/lib/types";

interface MarketPulseProps {
  data: StablecoinData[] | undefined;
  pegRates?: Record<string, number>;
  pegSummary?: { coins: PegSummaryCoin[]; summary: PegSummaryStats | null };
  blacklistEvents?: { events: BlacklistEvent[]; total: number };
}

function timeAgo(epochSec: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - epochSec) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

// ── Zone 1: Key Numbers ─────────────────────────────────────────────────

function KeyNumbers({
  data,
  pegSummary,
  blacklistEvents,
}: {
  data: StablecoinData[];
  pegSummary?: MarketPulseProps["pegSummary"];
  blacklistEvents?: MarketPulseProps["blacklistEvents"];
}) {
  const stats = useMemo(() => {
    const trackedIds = TRACKED_IDS;
    const trackedData = data.filter((c) => trackedIds.has(c.id));

    const totalMcap = trackedData.reduce((s, c) => s + getCirculatingRaw(c), 0);
    const totalPrevWeek = trackedData.reduce((s, c) => s + getPrevWeekRaw(c), 0);
    const weekPctChange =
      totalPrevWeek > 0 ? ((totalMcap - totalPrevWeek) / totalPrevWeek) * 100 : 0;

    // Governance breakdown
    const centralizedIds = new Set(
      TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").map((s) => s.id),
    );
    const dependentIds = new Set(
      TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").map((s) => s.id),
    );
    const decentralizedIds = new Set(
      TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").map((s) => s.id),
    );

    const centralizedMcap = trackedData
      .filter((c) => centralizedIds.has(c.id))
      .reduce((s, c) => s + getCirculatingRaw(c), 0);
    const dependentMcap = trackedData
      .filter((c) => dependentIds.has(c.id))
      .reduce((s, c) => s + getCirculatingRaw(c), 0);
    const decentralizedMcap = trackedData
      .filter((c) => decentralizedIds.has(c.id))
      .reduce((s, c) => s + getCirculatingRaw(c), 0);
    const govTotal = centralizedMcap + dependentMcap + decentralizedMcap;

    const cefiPct = govTotal > 0 ? (centralizedMcap / govTotal) * 100 : 0;
    const depPct = govTotal > 0 ? (dependentMcap / govTotal) * 100 : 0;
    const defiPct = govTotal > 0 ? (decentralizedMcap / govTotal) * 100 : 0;

    // 24h freezes
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const freezes24h = blacklistEvents?.events
      ? blacklistEvents.events.filter((e) => e.timestamp > oneDayAgo).length
      : 0;

    return {
      totalMcap,
      weekPctChange,
      totalPrevWeek,
      activeDepegs: pegSummary?.summary?.activeDepegCount ?? 0,
      freezes24h,
      cefiPct,
      depPct,
      defiPct,
    };
  }, [data, pegSummary, blacklistEvents]);

  const govTiers: { key: GovernanceType; pct: number }[] = [
    { key: "centralized", pct: stats.cefiPct },
    { key: "centralized-dependent", pct: stats.depPct },
    { key: "decentralized", pct: stats.defiPct },
  ];

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Key Numbers
      </p>

      {/* Total Mcap */}
      <div>
        <p className="text-xs text-muted-foreground">Total Mcap</p>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-bold font-mono tracking-tight">
            {formatCurrency(stats.totalMcap)}
          </span>
          {stats.totalPrevWeek > 0 && (
            <span
              className={`text-xs font-mono ${
                stats.weekPctChange >= 0 ? "text-green-500" : "text-red-500"
              }`}
            >
              {stats.weekPctChange >= 0 ? "\u2191" : "\u2193"}
              {Math.abs(stats.weekPctChange).toFixed(2)}% 7d
            </span>
          )}
        </div>
      </div>

      {/* Active Depegs */}
      <div>
        <p className="text-xs text-muted-foreground">Active Depegs</p>
        {stats.activeDepegs > 0 ? (
          <span className="text-lg font-bold font-mono text-red-500">
            {stats.activeDepegs}
          </span>
        ) : (
          <span className="text-sm font-semibold text-green-500">All stable</span>
        )}
      </div>

      {/* 24h Freezes */}
      <div>
        <p className="text-xs text-muted-foreground">24h Freezes</p>
        <span className="text-lg font-bold font-mono">
          {stats.freezes24h}
          <span className="text-xs font-normal text-muted-foreground ml-1">
            {stats.freezes24h === 1 ? "freeze" : "freezes"}
          </span>
        </span>
      </div>

      {/* CeFi Dominance + governance bar */}
      <div>
        <p className="text-xs text-muted-foreground">CeFi Dominance</p>
        <span className="text-lg font-bold font-mono">
          {stats.cefiPct.toFixed(1)}%
        </span>
        <div className="mt-1.5 h-2 w-full rounded-full bg-muted overflow-hidden flex">
          <div
            className="h-full bg-yellow-500"
            style={{ width: `${stats.cefiPct}%` }}
          />
          <div
            className="h-full bg-orange-500"
            style={{ width: `${stats.depPct}%` }}
          />
          <div
            className="h-full bg-green-500"
            style={{ width: `${stats.defiPct}%` }}
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {govTiers.map((t) => (
            <div key={t.key} className="flex items-center gap-1">
              <div className={`h-1.5 w-1.5 rounded-full ${GOVERNANCE_TIER_COLORS[t.key].bg}`} />
              <span className={`text-[10px] font-medium ${GOVERNANCE_TIER_COLORS[t.key].text}`}>
                {GOVERNANCE_LABELS_SHORT[t.key]} {t.pct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Zone 2: Movers & Signals ─────────────────────────────────────────────

function MoversSignals({
  data,
  pegSummary,
}: {
  data: StablecoinData[];
  pegSummary?: MarketPulseProps["pegSummary"];
}) {
  const signals = useMemo(() => {
    const trackedIds = TRACKED_IDS;
    const trackedData = data.filter((c) => trackedIds.has(c.id));

    // Biggest depeg from pegSummary
    const worstCurrent = pegSummary?.summary?.worstCurrent ?? null;

    // Biggest supply change (7d) among tracked coins with mcap > 1M
    let biggestMover: { symbol: string; delta: number } | null = null;
    let biggestAbsDelta = 0;
    for (const coin of trackedData) {
      const current = getCirculatingRaw(coin);
      if (current < 1_000_000) continue;
      const prev = getPrevWeekRaw(coin);
      const delta = current - prev;
      if (Math.abs(delta) > biggestAbsDelta) {
        biggestAbsDelta = Math.abs(delta);
        biggestMover = { symbol: coin.symbol, delta };
      }
    }

    // USDT/USDC dominance
    let usdtMcap = 0;
    let usdcMcap = 0;
    for (const coin of trackedData) {
      if (coin.id === "1") usdtMcap = getCirculatingRaw(coin);
      else if (coin.id === "2") usdcMcap = getCirculatingRaw(coin);
    }

    return { worstCurrent, biggestMover, usdtMcap, usdcMcap };
  }, [data, pegSummary]);

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Movers
      </p>

      {/* Biggest Depeg */}
      <div>
        <p className="text-xs text-muted-foreground">Biggest Depeg</p>
        {signals.worstCurrent ? (
          <span
            className={`text-sm font-semibold font-mono ${
              Math.abs(signals.worstCurrent.bps) >= 50
                ? "text-red-500"
                : Math.abs(signals.worstCurrent.bps) >= 10
                  ? "text-amber-500"
                  : "text-muted-foreground"
            }`}
          >
            {signals.worstCurrent.symbol}{" "}
            {signals.worstCurrent.bps >= 0 ? "+" : ""}
            {signals.worstCurrent.bps}bps
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">None</span>
        )}
      </div>

      {/* Biggest Supply Change */}
      <div>
        <p className="text-xs text-muted-foreground">Biggest Supply Change (7d)</p>
        {signals.biggestMover ? (
          <span
            className={`text-sm font-semibold font-mono ${
              signals.biggestMover.delta >= 0 ? "text-green-500" : "text-red-500"
            }`}
          >
            {signals.biggestMover.symbol}{" "}
            {signals.biggestMover.delta >= 0 ? "\u2191" : "\u2193"}
            {formatCurrency(Math.abs(signals.biggestMover.delta))}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">N/A</span>
        )}
      </div>

      {/* USDT/USDC Dominance */}
      <div>
        <p className="text-xs text-muted-foreground">USDT / USDC</p>
        <span className="text-sm font-semibold font-mono">
          USDT {formatCurrency(signals.usdtMcap, 0)}
        </span>
        <span className="text-muted-foreground mx-1">&middot;</span>
        <span className="text-sm font-semibold font-mono">
          USDC {formatCurrency(signals.usdcMcap, 0)}
        </span>
      </div>
    </div>
  );
}

// ── Zone 3: Recent Activity Ticker ───────────────────────────────────────

function ActivityTicker({
  pegSummary,
  blacklistEvents,
}: {
  pegSummary?: MarketPulseProps["pegSummary"];
  blacklistEvents?: MarketPulseProps["blacklistEvents"];
}) {
  const items = useMemo(() => {
    const entries: { text: string; timestamp: number }[] = [];

    // Blacklist events
    if (blacklistEvents?.events) {
      for (const evt of blacklistEvents.events) {
        const truncAddr = `${evt.address.slice(0, 6)}...${evt.address.slice(-4)}`;
        entries.push({
          text: `${evt.stablecoin} froze ${truncAddr} on ${evt.chainName} \u2014 ${timeAgo(evt.timestamp)}`,
          timestamp: evt.timestamp,
        });
      }
    }

    // Active depegs
    if (pegSummary?.coins) {
      const nowSec = Math.floor(Date.now() / 1000);
      for (const coin of pegSummary.coins) {
        if (!coin.activeDepeg) continue;
        const bps = coin.currentDeviationBps ?? 0;
        entries.push({
          text: `${coin.symbol} depegged ${bps >= 0 ? "+" : ""}${bps}bps \u2014 active`,
          timestamp: nowSec,
        });
      }
    }

    // Sort by timestamp descending, take last 3
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, 3);
  }, [pegSummary, blacklistEvents]);

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Activity
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No recent activity</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <p key={i} className="text-xs leading-relaxed text-foreground/80">
              {item.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────

function MarketPulseSkeleton() {
  return (
    <Card className="rounded-2xl">
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Zone 1 skeleton */}
          <div className="space-y-3">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-36" />
          </div>
          {/* Zone 2 skeleton */}
          <div className="space-y-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-5 w-32" />
          </div>
          {/* Zone 3 skeleton */}
          <div className="space-y-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Export ──────────────────────────────────────────────────────────

export function MarketPulse({
  data,
  pegSummary,
  blacklistEvents,
}: MarketPulseProps) {
  if (!data) {
    return <MarketPulseSkeleton />;
  }

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-3 lg:divide-x lg:divide-border">
          <div className="lg:pr-6">
            <KeyNumbers
              data={data}
              pegSummary={pegSummary}
              blacklistEvents={blacklistEvents}
            />
          </div>
          <div className="lg:px-6">
            <MoversSignals data={data} pegSummary={pegSummary} />
          </div>
          <div className="lg:pl-6">
            <ActivityTicker
              pegSummary={pegSummary}
              blacklistEvents={blacklistEvents}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
