"use client";

import { useMemo } from "react";
import {
  Flame,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { FlowMachineScene } from "@/components/flow-machine-scene";
import { formatCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import type { MintBurnCoinFlow, MintBurnGauge, MintBurnHourlyBucket } from "@shared/types";
import { cn } from "@/lib/utils";

interface FlowBrrrOverviewProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  isLoading?: boolean;
  className?: string;
}

interface PrinterMode {
  label: string;
  badgeClass: string;
  headlineClass: string;
  panelClass: string;
  description: string;
}

interface FlowSnapshot {
  mint24h: number;
  burn24h: number;
  net24h: number;
  mint7d: number | null;
  burn7d: number | null;
  net7d: number;
  score: number | null;
  trackedCoins: number;
  topMint: MintBurnCoinFlow | null;
  topBurn: MintBurnCoinFlow | null;
  headline: string;
  brrText: string;
  leverPct: number | null;
  mode: PrinterMode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatSignedCurrency(value: number): string {
  return `${getNetPrefix(value)}${formatCurrency(value)}`;
}

function formatMaybeCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return formatCurrency(value);
}

function getHeadline(score: number | null, net24h: number, brrText: string): string {
  if (score === null) {
    return "No flow score data";
  }
  if (score >= 70) {
    return `Money printer go ${brrText}`;
  }
  if (score >= -10 && score < 10) {
    return "Money printer on standby";
  }
  if (score < -40 || (score < -10 && net24h < 0)) {
    return "Money shredder go BRRR";
  }
  if (score >= 40) {
    return `Money printer go ${brrText}`;
  }
  if (score >= 10) {
    return "Money printer warming up";
  }
  return "Money printer sputtering";
}

function getPrinterMode(score: number | null, net24h: number): PrinterMode {
  if (score === null) {
    return {
      label: "NO DATA",
      badgeClass: "bg-muted text-muted-foreground border-border/70",
      headlineClass: "text-muted-foreground",
      panelClass: "border-border/60 bg-background/35",
      description: "Not enough history to compute a reliable flow-intensity score yet.",
    };
  }
  if (score >= 70) {
    return {
      label: "MAX BRRRR",
      badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
      headlineClass: "text-emerald-300",
      panelClass: "border-emerald-500/35 bg-emerald-500/10",
      description: "Issuance is extreme relative to baseline activity.",
    };
  }
  if (score >= 40) {
    return {
      label: "PRINT SURGE",
      badgeClass: "bg-lime-500/20 text-lime-300 border-lime-500/40",
      headlineClass: "text-lime-300",
      panelClass: "border-lime-500/35 bg-lime-500/10",
      description: "Strong mint pressure. Demand for stable liquidity is elevated.",
    };
  }
  if (score >= 10) {
    return {
      label: "PRINTING",
      badgeClass: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
      headlineClass: "text-cyan-300",
      panelClass: "border-cyan-500/35 bg-cyan-500/10",
      description: "Net inflows are positive but not yet euphoric.",
    };
  }
  if (score >= -10) {
    return {
      label: "NEUTRAL",
      badgeClass: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
      headlineClass: "text-zinc-200",
      panelClass: "border-border/60 bg-background/35",
      description: "Printer and shredder are roughly balanced.",
    };
  }
  if (score >= -40) {
    return {
      label: "SHREDDING",
      badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/40",
      headlineClass: "text-amber-300",
      panelClass: "border-amber-500/35 bg-amber-500/10",
      description: "Burn pressure is climbing versus normal flow.",
    };
  }
  if (net24h < 0) {
    return {
      label: "REVERSE BRRRR",
      badgeClass: "bg-red-500/20 text-red-300 border-red-500/40",
      headlineClass: "text-red-300",
      panelClass: "border-red-500/35 bg-red-500/10",
      description: "Net supply is contracting hard. Redemptions dominate.",
    };
  }
  return {
    label: "STRESSED",
    badgeClass: "bg-red-500/20 text-red-300 border-red-500/40",
    headlineClass: "text-red-300",
    panelClass: "border-red-500/35 bg-red-500/10",
    description: "Score is weak despite net flow trying to recover.",
  };
}

function buildSnapshot(
  gauge: MintBurnGauge | null,
  coins: MintBurnCoinFlow[],
  weeklyHourly?: MintBurnHourlyBucket[],
): FlowSnapshot {
  let mint24h = 0;
  let burn24h = 0;
  let net24h = 0;
  let net7d = 0;

  for (const coin of coins) {
    mint24h += coin.mintVolume24hUsd;
    burn24h += coin.burnVolume24hUsd;
    net24h += coin.netFlow24hUsd;
    net7d += coin.netFlow7dUsd;
  }

  let mint7d: number | null = null;
  let burn7d: number | null = null;
  if (weeklyHourly && weeklyHourly.length > 0) {
    mint7d = 0;
    burn7d = 0;
    for (const bucket of weeklyHourly) {
      mint7d += bucket.mintVolumeUsd;
      burn7d += bucket.burnVolumeUsd;
    }
  }

  const topMint = [...coins]
    .filter((coin) => coin.netFlow24hUsd > 0)
    .sort((a, b) => b.netFlow24hUsd - a.netFlow24hUsd)[0] ?? null;

  const topBurn = [...coins]
    .filter((coin) => coin.netFlow24hUsd < 0)
    .sort((a, b) => a.netFlow24hUsd - b.netFlow24hUsd)[0] ?? null;

  const score = gauge?.score ?? null;
  const leverPct = score === null ? null : clamp((score + 100) / 2, 0, 100);
  const rCount = score === null ? 4 : clamp(Math.round((leverPct ?? 50) / 7), 2, 14);
  const brrText = `BR${"R".repeat(rCount)}`;
  const mode = getPrinterMode(score, net24h);

  return {
    mint24h,
    burn24h,
    net24h,
    mint7d,
    burn7d,
    net7d,
    score,
    trackedCoins: gauge?.trackedCoins ?? coins.length,
    topMint,
    topBurn,
    headline: getHeadline(score, net24h, brrText),
    brrText,
    leverPct,
    mode,
  };
}

function LoadingState() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 1 }).map((_, i) => (
        <div key={i} className="rounded-2xl border bg-card p-4 sm:p-6 animate-pulse">
          <div className="h-4 w-44 rounded bg-muted/60" />
          <div className="mt-4 h-9 w-full max-w-[620px] rounded bg-muted/60" />
          <div className="mt-4 h-4 w-full max-w-[760px] rounded bg-muted/60" />
          <div className="mt-5 h-32 rounded-xl bg-muted/60" />
        </div>
      ))}
    </div>
  );
}

function IterationOne({ snapshot, gauge }: { snapshot: FlowSnapshot; gauge: MintBurnGauge | null }) {
  const machineMode = snapshot.net24h < 0 ? "shredder" : "printer";
  const ratePower = snapshot.score === null ? 0.28 : clamp((snapshot.leverPct ?? 0) / 100, 0.1, 1);
  const totalFlow24h = snapshot.mint24h + snapshot.burn24h;
  const burnDominance = totalFlow24h > 0 ? snapshot.burn24h / totalFlow24h : 0.5;
  const burnPower = machineMode === "shredder" ? clamp((burnDominance - 0.5) / 0.5, 0.12, 1) : 0;
  const sceneIntensity = machineMode === "shredder" ? burnPower : ratePower;
  const sceneStatus = snapshot.score === null
    ? "NO DATA"
    : machineMode === "shredder"
      ? `Burn ${Math.round(burnPower * 100)}%`
      : `Rate ${Math.round(ratePower * 100)}%`;
  const sceneStress = snapshot.score === null || snapshot.score >= -10
    ? 0
    : (-10 - snapshot.score) / 90;

  return (
    <article className="relative h-full overflow-hidden rounded-2xl border bg-card p-4 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          background:
            "radial-gradient(1200px 260px at 5% 0%, rgba(34,211,238,0.13), transparent 60%), radial-gradient(780px 240px at 100% 100%, rgba(16,185,129,0.18), transparent 65%)",
        }}
      />

      <div className="relative space-y-5">
        <header className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold", snapshot.mode.badgeClass)}>
            {snapshot.mode.label}
          </span>
          {gauge?.flightToQuality && (
            <span className="inline-flex rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
              FTQ {Math.round(gauge.flightIntensity)}%
            </span>
          )}
        </header>

        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            <h3 className={cn("text-3xl font-black tracking-tight sm:text-5xl", snapshot.mode.headlineClass)}>
              {snapshot.headline}
            </h3>
            <p className="text-sm text-muted-foreground">{snapshot.mode.description}</p>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Minted 24h</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {formatCurrency(snapshot.mint24h)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Burned 24h</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-red-400">
                  <TrendingDown className="h-3.5 w-3.5" />
                  {formatCurrency(snapshot.burn24h)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net 24h</p>
                <p className={cn("mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold", getNetColor(snapshot.net24h))}>
                  <Flame className="h-3.5 w-3.5" />
                  {formatSignedCurrency(snapshot.net24h)}
                </p>
              </div>
            </div>

            <div className="hidden lg:grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Minted 7d</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {formatMaybeCurrency(snapshot.mint7d)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Burned 7d</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-red-400">
                  <TrendingDown className="h-3.5 w-3.5" />
                  {formatMaybeCurrency(snapshot.burn7d)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net 7d</p>
                <p className={cn("mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold", getNetColor(snapshot.net7d))}>
                  <Flame className="h-3.5 w-3.5" />
                  {formatSignedCurrency(snapshot.net7d)}
                </p>
              </div>
            </div>

            <div className={cn("space-y-2 rounded-xl border p-3", snapshot.mode.panelClass)}>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Printer pressure lever</span>
                <span className="font-mono">
                  {snapshot.score === null
                    ? "NO DATA"
                    : `${getNetPrefix(snapshot.score)}${Math.round(snapshot.score)} / 100`}
                </span>
              </div>
              <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
                <div
                  className="h-full rounded-full"
                  style={{ background: "linear-gradient(90deg, #ef4444 0%, #f59e0b 35%, #84cc16 65%, #10b981 100%)" }}
                />
                {snapshot.leverPct !== null && (
                  <div
                    className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
                    style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <FlowMachineScene
              size="full"
              mode={machineMode}
              intensity={sceneIntensity}
              statusText={sceneStatus}
              title={machineMode === "shredder" ? "Shredder Desk" : "Printer Desk"}
              subText={`Tracking ${snapshot.trackedCoins} stablecoins`}
              stress={sceneStress}
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Top minter</p>
                <p className="mt-1 font-mono text-xs">
                  {snapshot.topMint ? (
                    <span className="text-emerald-400">
                      {snapshot.topMint.symbol} +{formatCurrency(snapshot.topMint.netFlow24hUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None in this window</span>
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Top burner</p>
                <p className="mt-1 font-mono text-xs">
                  {snapshot.topBurn ? (
                    <span className="text-red-400">
                      {snapshot.topBurn.symbol} {formatCurrency(snapshot.topBurn.netFlow24hUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None in this window</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export function FlowBrrrOverview({ gauge, coins, weeklyHourly, isLoading, className }: FlowBrrrOverviewProps) {
  const snapshot = useMemo(
    () => buildSnapshot(gauge, coins, weeklyHourly),
    [gauge, coins, weeklyHourly],
  );

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className={cn("h-full space-y-4", className)}>
      <IterationOne snapshot={snapshot} gauge={gauge} />
    </div>
  );
}

export type { FlowBrrrOverviewProps };
