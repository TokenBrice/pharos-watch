"use client";

import { useMemo, type CSSProperties } from "react";
import {
  Banknote,
  Flame,
  Printer,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { formatCurrency, getNetColor, getNetPrefix } from "@/lib/format";
import type { MintBurnCoinFlow, MintBurnGauge } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FlowBrrrOverviewProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  isLoading?: boolean;
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
  score: number | null;
  trackedCoins: number;
  topMint: MintBurnCoinFlow | null;
  topBurn: MintBurnCoinFlow | null;
  brrText: string;
  leverPct: number;
  mode: PrinterMode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatSignedCurrency(value: number): string {
  return `${getNetPrefix(value)}${formatCurrency(value)}`;
}

function getPrinterMode(score: number | null, net24h: number): PrinterMode {
  if (score === null) {
    return {
      label: "CALIBRATING",
      badgeClass: "bg-muted text-muted-foreground border-border/70",
      headlineClass: "text-muted-foreground",
      panelClass: "border-border/60 bg-background/35",
      description: "Baseline still warming up. Signal confidence is limited.",
    };
  }
  if (score >= 85) {
    return {
      label: "MAX BRRRR",
      badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
      headlineClass: "text-emerald-300",
      panelClass: "border-emerald-500/35 bg-emerald-500/10",
      description: "Issuance is extreme relative to baseline activity.",
    };
  }
  if (score >= 70) {
    return {
      label: "PRINT SURGE",
      badgeClass: "bg-lime-500/20 text-lime-300 border-lime-500/40",
      headlineClass: "text-lime-300",
      panelClass: "border-lime-500/35 bg-lime-500/10",
      description: "Strong mint pressure. Demand for stable liquidity is elevated.",
    };
  }
  if (score >= 55) {
    return {
      label: "PRINTING",
      badgeClass: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
      headlineClass: "text-cyan-300",
      panelClass: "border-cyan-500/35 bg-cyan-500/10",
      description: "Net inflows are positive but not yet euphoric.",
    };
  }
  if (score >= 45) {
    return {
      label: "NEUTRAL",
      badgeClass: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
      headlineClass: "text-zinc-200",
      panelClass: "border-border/60 bg-background/35",
      description: "Printer and shredder are roughly balanced.",
    };
  }
  if (score >= 30) {
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

function buildSnapshot(gauge: MintBurnGauge | null, coins: MintBurnCoinFlow[]): FlowSnapshot {
  let mint24h = 0;
  let burn24h = 0;
  let net24h = 0;

  for (const coin of coins) {
    mint24h += coin.mintVolume24hUsd;
    burn24h += coin.burnVolume24hUsd;
    net24h += coin.netFlow24hUsd;
  }

  const topMint = [...coins]
    .filter((coin) => coin.netFlow24hUsd > 0)
    .sort((a, b) => b.netFlow24hUsd - a.netFlow24hUsd)[0] ?? null;

  const topBurn = [...coins]
    .filter((coin) => coin.netFlow24hUsd < 0)
    .sort((a, b) => a.netFlow24hUsd - b.netFlow24hUsd)[0] ?? null;

  const score = gauge?.score ?? null;
  const leverPct = score === null ? 50 : clamp(score, 0, 100);
  const rCount = score === null ? 4 : clamp(Math.round(leverPct / 7), 2, 14);
  const mode = getPrinterMode(score, net24h);

  return {
    mint24h,
    burn24h,
    net24h,
    score,
    trackedCoins: gauge?.trackedCoins ?? coins.length,
    topMint,
    topBurn,
    brrText: `BR${"R".repeat(rCount)}`,
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

function PrinterScene({ snapshot }: { snapshot: FlowSnapshot }) {
  const power = snapshot.score === null ? 0.28 : clamp(snapshot.leverPct / 100, 0.1, 1);
  const surgeBoost = power > 0.7 ? (power - 0.7) / 0.3 : 0;
  const sheetCount = clamp(Math.round(5 + power * 12 + surgeBoost * 18), 4, 35);
  const baseDuration = clamp(2.2 - power * 1.4 - surgeBoost * 0.35, 0.42, 2.2);
  const rollerDuration = clamp(1.6 - power * 1.0 - surgeBoost * 0.25, 0.34, 1.6);
  const crankDuration = clamp(2.4 - power * 1.8 - surgeBoost * 0.45, 0.38, 2.4);
  const glowOpacity = 0.2 + power * 0.55 + surgeBoost * 0.18;
  const spreadX = 86 + Math.round(power * 42);
  const riseBase = 42 + Math.round(power * 24);
  const riseStep = 11 + Math.round(power * 5);
  const durationStep = clamp(0.18 - power * 0.08, 0.06, 0.18);
  const delayStep = clamp(0.16 - power * 0.09, 0.05, 0.16);
  const emissionOffsetX = 16;
  const spreadPattern = [-1, -0.82, -0.64, -0.46, -0.28, -0.1, 0, 0.1, 0.28, 0.46, 0.64, 0.82, 1];

  return (
    <div className="relative min-h-[280px] overflow-hidden rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Printer className="h-3.5 w-3.5" />
          Printer Desk
        </span>
        <span className="font-mono tabular-nums">
          {snapshot.score === null ? "CALIBRATING" : `Rate ${Math.round(power * 100)}%`}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/85">
        Tracking {snapshot.trackedCoins} stablecoins
      </p>

      <div className="relative mt-4 h-[178px]">
        <div
          className="pointer-events-none absolute left-1/2 top-2 h-16 w-32 -translate-x-1/2 rounded-t-xl border border-slate-600/70 bg-slate-700/70"
          style={{ boxShadow: `0 0 20px rgba(16,185,129,${glowOpacity * 0.28})` }}
        />
        <div className="pointer-events-none absolute left-1/2 top-14 h-24 w-56 -translate-x-1/2 rounded-2xl border border-slate-600/80 bg-slate-900/85 shadow-[inset_0_-14px_24px_rgba(0,0,0,0.35)]" />
        <div className="pointer-events-none absolute left-1/2 top-[88px] h-3 w-44 -translate-x-1/2 rounded bg-black/55 border border-slate-700/80" />

        <div className="pointer-events-none absolute left-[calc(50%-84px)] top-[104px] h-4 w-10 rounded-full border border-slate-500/70 bg-slate-500/45 printer-roller" style={{ animationDuration: `${rollerDuration.toFixed(2)}s` }} />
        <div className="pointer-events-none absolute left-[calc(50%+44px)] top-[104px] h-4 w-10 rounded-full border border-slate-500/70 bg-slate-500/45 printer-roller" style={{ animationDuration: `${(rollerDuration * 0.92).toFixed(2)}s` }} />

        <div
          className="pointer-events-none absolute right-[calc(50%-102px)] top-[72px] h-4 w-4 rounded-full border border-emerald-300/45 bg-emerald-400/25 printer-light"
          style={{ animationDuration: `${(1.8 - power * 1.0).toFixed(2)}s`, boxShadow: `0 0 12px rgba(52,211,153,${glowOpacity})` }}
        />

        <div className="pointer-events-none absolute left-[calc(50%+94px)] top-[103px] h-3 w-3 rounded-full border border-slate-500/80 bg-slate-300/60" />
        <div
          className="pointer-events-none absolute left-[calc(50%+97px)] top-[89px] h-10 w-10 origin-[2px_50%] printer-crank"
          style={{ animationDuration: `${crankDuration.toFixed(2)}s` }}
        >
          <div className="absolute left-0 top-1/2 h-[3px] w-9 -translate-y-1/2 rounded bg-slate-300/85" />
          <div className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-slate-500/80 bg-slate-200/90" />
        </div>

        <div className="pointer-events-none absolute left-1/2 top-[18px] h-14 w-24 -translate-x-1/2 rounded border border-slate-500/70 bg-gradient-to-b from-slate-300/70 to-slate-200/25" />

        {Array.from({ length: sheetCount }).map((_, i) => {
          const dx = Math.round(spreadPattern[i % spreadPattern.length] * spreadX);
          const dy = riseBase + (i % 8) * riseStep;
          const rot = -28 + (i % 8) * 8;
          const style: CSSProperties = {
            left: `calc(50% + ${emissionOffsetX}px)`,
            animationDuration: `${(baseDuration + (i % 6) * durationStep).toFixed(2)}s`,
            animationDelay: `${(-i * delayStep).toFixed(2)}s`,
            "--paper-dx": `${dx}px`,
            "--paper-dy": `${dy}px`,
            "--paper-rot": `${rot}deg`,
          };

          return (
            <div
              key={i}
              className="pointer-events-none absolute top-[92px] flex h-5 w-9 -translate-x-1/2 items-center justify-center rounded-sm border border-emerald-500/45 bg-emerald-300/75 text-emerald-950 paper-fly"
              style={style}
            >
              <Banknote className="h-3 w-3" />
            </div>
          );
        })}
      </div>

      <div className="absolute inset-x-4 bottom-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
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

      <style jsx>{`
        .paper-fly {
          animation-name: paper-fly;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .printer-roller {
          animation-name: roller-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .printer-light {
          animation-name: status-blink;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }
        .printer-crank {
          animation-name: crank-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }

        @keyframes paper-fly {
          0% {
            opacity: 0;
            transform: translate(-50%, 0) scale(0.7) rotate(0deg);
          }
          9% {
            opacity: 1;
          }
          62% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform:
              translate(calc(-50% + var(--paper-dx)), calc(-1 * var(--paper-dy)))
              scale(1.02)
              rotate(var(--paper-rot));
          }
        }

        @keyframes roller-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes status-blink {
          0%, 100% {
            opacity: 0.45;
          }
          50% {
            opacity: 1;
          }
        }

        @keyframes crank-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

function IterationOne({ snapshot, gauge }: { snapshot: FlowSnapshot; gauge: MintBurnGauge | null }) {
  return (
    <article className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-6">
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Iteration 1 - Desk Cut
          </p>
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
              Money printer go {snapshot.brrText}
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

            <div className={cn("space-y-2 rounded-xl border p-3", snapshot.mode.panelClass)}>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Printer pressure lever</span>
                <span className="font-mono">{snapshot.score === null ? "CALIBRATING" : `${Math.round(snapshot.score)} / 100`}</span>
              </div>
              <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
                <div
                  className="h-full rounded-full"
                  style={{ background: "linear-gradient(90deg, #ef4444 0%, #f59e0b 35%, #84cc16 65%, #10b981 100%)" }}
                />
                <div
                  className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
                  style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
                />
              </div>
            </div>
          </div>

          <PrinterScene snapshot={snapshot} />
        </div>
      </div>
    </article>
  );
}

export function FlowBrrrOverview({ gauge, coins, isLoading }: FlowBrrrOverviewProps) {
  const snapshot = useMemo(() => buildSnapshot(gauge, coins), [gauge, coins]);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-4">
      <IterationOne snapshot={snapshot} gauge={gauge} />
    </div>
  );
}

export type { FlowBrrrOverviewProps };
