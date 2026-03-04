"use client";

import Link from "next/link";
import { type CSSProperties } from "react";
import { ArrowRight, Banknote, Printer } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMintBurnFlows, useMintBurnFlowsCoin } from "@/hooks/use-mint-burn-flows";
import { formatCurrency, getNetColor, getNetPrefix } from "@/lib/format";
import { getMintBurnSummaryTimeframe, getNetFlowForHours } from "@/lib/mint-burn-timeframes";
import { GAUGE_BANDS } from "@/components/flow-gauge";
import { cn } from "@/lib/utils";

function getBandForScore(score: number): string {
  if (score < 15) return "CRISIS";
  if (score < 30) return "STRESS";
  if (score < 45) return "CAUTIOUS";
  if (score < 55) return "NEUTRAL";
  if (score < 70) return "HEALTHY";
  if (score < 85) return "CONFIDENT";
  return "SURGE";
}

type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowSummaryCardProps {
  stablecoinId: string;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SummarySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-sm">
          <Skeleton className="h-4 w-28" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[210px] w-full rounded-xl" />
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface MiniPrinterSceneProps {
  intensity: number | null;
  intensityDisplay: number | null;
  bandConfig: { label: string; hex: string; textClass: string; bgClass: string } | null;
}

function MiniPrinterScene({ intensity, intensityDisplay, bandConfig }: MiniPrinterSceneProps) {
  const power = intensity == null ? 0.5 : clamp(intensity / 100, 0.08, 1);
  const eased = Math.pow(power, 1.35);
  const sheetCount = clamp(Math.round(4 + eased * 14), 4, 18);
  const baseDuration = clamp(2.2 - eased * 1.4, 0.55, 2.2);
  const rollerDuration = clamp(1.8 - eased * 1.2, 0.5, 1.8);
  const crankDuration = clamp(2.5 - Math.pow(power, 1.7) * 1.8, 0.45, 2.5);
  const spreadX = 42 + Math.round(eased * 78);
  const riseY = 34 + Math.round(eased * 56);
  const delayStep = clamp(0.16 - power * 0.08, 0.06, 0.16);
  const accent = bandConfig?.hex ?? "#6b7280";
  const spreadPattern = [-1, -0.75, -0.52, -0.3, -0.12, 0, 0.12, 0.3, 0.52, 0.75, 1];

  return (
    <div className="relative h-[210px] overflow-hidden rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Printer className="h-3.5 w-3.5" />
          Printer
        </span>
        <span className="font-mono tabular-nums">
          {intensityDisplay != null ? `${intensityDisplay}%` : "CAL"}
        </span>
      </div>

      <div className="relative mt-2 h-[160px]">
        <div
          className="pointer-events-none absolute left-1/2 top-3 h-12 w-24 -translate-x-1/2 rounded-t-xl border border-slate-600/70 bg-slate-700/70"
          style={{ boxShadow: `0 0 16px ${accent}33` }}
        />
        <div className="pointer-events-none absolute left-1/2 top-12 h-20 w-48 -translate-x-1/2 rounded-2xl border border-slate-600/80 bg-slate-900/85" />
        <div className="pointer-events-none absolute left-1/2 top-[84px] h-3 w-36 -translate-x-1/2 rounded border border-slate-700/80 bg-black/55" />

        <div className="pointer-events-none absolute left-[calc(50%-66px)] top-[96px] h-4 w-9 rounded-full border border-slate-500/70 bg-slate-500/45 mini-printer-roller" style={{ animationDuration: `${rollerDuration.toFixed(2)}s` }} />
        <div className="pointer-events-none absolute left-[calc(50%+32px)] top-[96px] h-4 w-9 rounded-full border border-slate-500/70 bg-slate-500/45 mini-printer-roller" style={{ animationDuration: `${(rollerDuration * 0.92).toFixed(2)}s` }} />

        <div
          className="pointer-events-none absolute left-[calc(50%+82px)] top-[89px] h-8 w-8 origin-[2px_50%] mini-printer-crank"
          style={{ animationDuration: `${crankDuration.toFixed(2)}s` }}
        >
          <div className="absolute left-0 top-1/2 h-[3px] w-7 -translate-y-1/2 rounded bg-slate-300/85" />
          <div className="absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border border-slate-500/80 bg-slate-200/90" />
        </div>

        <div className="pointer-events-none absolute left-1/2 top-[22px] h-10 w-16 -translate-x-1/2 rounded border border-slate-500/70 bg-gradient-to-b from-slate-300/70 to-slate-200/25" />

        {Array.from({ length: sheetCount }).map((_, i) => {
          const dx = Math.round(spreadPattern[i % spreadPattern.length] * spreadX);
          const rot = -22 + (i % 7) * 7;
          const style: CssVarStyle = {
            left: "calc(50% + 12px)",
            animationDuration: `${(baseDuration + (i % 5) * 0.08).toFixed(2)}s`,
            animationDelay: `${(-i * delayStep).toFixed(2)}s`,
            "--paper-dx": `${dx}px`,
            "--paper-dy": `${riseY + (i % 6) * 7}px`,
            "--paper-rot": `${rot}deg`,
          };

          return (
            <div
              key={i}
              className="pointer-events-none absolute top-[86px] flex h-4.5 w-8 -translate-x-1/2 items-center justify-center rounded-sm border border-emerald-500/45 bg-emerald-300/75 text-emerald-950 mini-paper-fly"
              style={style}
            >
              <Banknote className="h-2.5 w-2.5" />
            </div>
          );
        })}
      </div>

      <style jsx>{`
        .mini-paper-fly {
          animation-name: mini-paper-fly;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .mini-printer-roller {
          animation-name: mini-roller-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .mini-printer-crank {
          animation-name: mini-crank-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }

        @keyframes mini-paper-fly {
          0% {
            opacity: 0;
            transform: translate(-50%, 0) scale(0.72) rotate(0deg);
          }
          10% {
            opacity: 1;
          }
          64% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--paper-dx)), calc(-1 * var(--paper-dy))) scale(1) rotate(var(--paper-rot));
          }
        }

        @keyframes mini-roller-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes mini-crank-spin {
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  const timeframe = getMintBurnSummaryTimeframe(stablecoinId);
  const needsCustomShortWindow = timeframe.shortHours !== 24;
  const needsCustomLongWindow = timeframe.longHours !== 7 * 24;
  const shouldFetchLongWindow = needsCustomLongWindow && timeframe.longHours !== timeframe.shortHours;

  // Use aggregate endpoint (no stablecoin param) — per-coin endpoint returns a
  // different response shape without the `coins` array.
  const { data, isLoading } = useMintBurnFlows();
  const { data: shortWindowData, isLoading: isShortWindowLoading } = useMintBurnFlowsCoin(
    stablecoinId,
    timeframe.shortHours,
    { enabled: needsCustomShortWindow },
  );
  const { data: longWindowData, isLoading: isLongWindowLoading } = useMintBurnFlowsCoin(
    stablecoinId,
    timeframe.longHours,
    { enabled: shouldFetchLongWindow },
  );

  if (
    isLoading
    || (needsCustomShortWindow && isShortWindowLoading)
    || (shouldFetchLongWindow && isLongWindowLoading)
  ) {
    return <SummarySkeleton />;
  }

  // Return nothing if there's no data for this coin
  if (!data?.coins) return null;

  const coin = data.coins.find((c) => c.stablecoinId === stablecoinId);
  if (!coin) return null;

  const shortNetFlow = needsCustomShortWindow
    ? (shortWindowData?.netFlowUsd ?? getNetFlowForHours(coin, timeframe.shortHours) ?? Number.NaN)
    : coin.netFlow24hUsd;
  const longNetFlow = needsCustomLongWindow
    ? (
      shouldFetchLongWindow
        ? (longWindowData?.netFlowUsd ?? getNetFlowForHours(coin, timeframe.longHours) ?? Number.NaN)
        : shortNetFlow
    )
    : coin.netFlow7dUsd;
  const intensity = coin.flowIntensity;
  const intensityDisplay = intensity != null ? Math.round(intensity) : null;
  const bandKey = intensity != null ? getBandForScore(intensity) : null;
  const bandConfig = bandKey ? GAUGE_BANDS[bandKey] : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-sm">
          Mint &amp; Burn Flows
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="space-y-2">
            <MiniPrinterScene
              intensity={intensity}
              intensityDisplay={intensityDisplay}
              bandConfig={bandConfig ?? null}
            />
            <Link
              href="/flows"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View all flows
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/35 p-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Flow Intensity</p>
                  <p className={cn("font-mono text-2xl font-black leading-none", bandConfig?.textClass ?? "text-muted-foreground")}>
                    {intensityDisplay != null ? intensityDisplay : "\u2014"}
                  </p>
                </div>
                {intensity != null && bandConfig ? (
                  <span
                    className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold")}
                    style={{
                      color: bandConfig.hex,
                      borderColor: `${bandConfig.hex}66`,
                      backgroundColor: `${bandConfig.hex}22`,
                    }}
                  >
                    {bandConfig.label}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Calibrating</span>
                )}
              </div>
              <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
                {intensity != null && bandConfig && (
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, intensity)}%`,
                      backgroundColor: bandConfig.hex,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/60 bg-background/30 p-3 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net {timeframe.shortLabel}</p>
                <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(shortNetFlow)}`}>
                  {getNetPrefix(shortNetFlow)}{formatCurrency(shortNetFlow)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/30 p-3 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net {timeframe.longLabel}</p>
                <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(longNetFlow)}`}>
                  {getNetPrefix(longNetFlow)}{formatCurrency(longNetFlow)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/30 p-3 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net 30d</p>
                <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(coin.netFlow30dUsd)}`}>
                  {getNetPrefix(coin.netFlow30dUsd)}{formatCurrency(coin.netFlow30dUsd)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/30 p-3 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net 90d</p>
                <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(coin.netFlow90dUsd)}`}>
                  {getNetPrefix(coin.netFlow90dUsd)}{formatCurrency(coin.netFlow90dUsd)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
