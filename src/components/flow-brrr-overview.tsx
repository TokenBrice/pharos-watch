"use client";

import { useMemo } from "react";
import { Flame, TrendingDown, TrendingUp } from "lucide-react";
import { FlowMachineScene } from "@/components/flow-machine-scene";
import { MintingPressureGauge } from "@/components/minting-pressure-gauge";
import {
  formatCurrency,
  formatSignedCurrency,
  getNetColor,
  getNetPrefix,
} from "@shared/lib/format";
import type {
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
} from "@shared/types";
import {
  buildFlowOverviewDescription,
  buildFlowOverviewHeadline,
  getFlowDirectionUi,
  getFlowPressureUi,
  type FlowDirectionUi,
  type FlowPressureUi,
} from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import { clamp } from "@shared/lib/math";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { MethodologyLabel } from "@/components/methodology-hint";

interface FlowBrrrOverviewProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  isLoading?: boolean;
  className?: string;
  variant?: "default" | "compact";
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
  description: string;
  leverPct: number | null;
  has24hActivity: boolean;
  netDirection: NetFlowDirection24h;
  pressureState: PressureShiftState;
  directionUi: FlowDirectionUi;
  pressureUi: FlowPressureUi;
}

function formatMaybeCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return formatCurrency(value);
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

  const topMint =
    [...coins]
      .filter((coin) => coin.netFlow24hUsd > 0)
      .sort((a, b) => b.netFlow24hUsd - a.netFlow24hUsd)[0] ?? null;
  const topBurn =
    [...coins]
      .filter((coin) => coin.netFlow24hUsd < 0)
      .sort((a, b) => a.netFlow24hUsd - b.netFlow24hUsd)[0] ?? null;

  const score = gauge?.score ?? null;
  const has24hActivity = Boolean(mint24h || burn24h || net24h);
  const netDirection = getNetFlowDirection24h({
    netFlow24hUsd: net24h,
    has24hActivity,
  });
  const pressureState = getPressureShiftState(score);
  const leverPct = score === null ? null : clamp((score + 100) / 2, 0, 100);

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
    headline: buildFlowOverviewHeadline(netDirection, pressureState),
    description: buildFlowOverviewDescription(netDirection, pressureState),
    leverPct,
    has24hActivity,
    netDirection,
    pressureState,
    directionUi: getFlowDirectionUi(netDirection, "overview"),
    pressureUi: getFlowPressureUi(pressureState, "overview"),
  };
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="animate-pulse rounded-2xl border bg-card p-4 sm:p-6">
        <div className="h-4 w-44 rounded bg-muted/60" />
        <div className="mt-4 h-9 w-full max-w-[620px] rounded bg-muted/60" />
        <div className="mt-4 h-4 w-full max-w-[760px] rounded bg-muted/60" />
        <div className="mt-5 h-32 rounded-xl bg-muted/60" />
      </div>
    </div>
  );
}

function IterationOne({
  snapshot,
  gauge,
  variant = "default",
}: {
  snapshot: FlowSnapshot;
  gauge: MintBurnGauge | null;
  variant?: "default" | "compact";
}) {
  const isCompact = variant === "compact";
  const totalFlow24h = snapshot.mint24h + snapshot.burn24h;
  const netDominance = snapshot.has24hActivity
    ? Math.abs(snapshot.net24h) / Math.max(totalFlow24h, 1)
    : 0.08;
  const pressurePower = snapshot.score === null
    ? 0.18
    : Math.abs(snapshot.score) / 100;
  const sceneIntensity = snapshot.netDirection === "flat"
    ? 0.12
    : clamp(Math.max(netDominance, pressurePower * 0.6), 0.12, 1);
  const sceneStress = snapshot.score === null || snapshot.score >= -10
    ? 0
    : clamp((-10 - snapshot.score) / 90, 0, 1);
  const gaugeDisplay = snapshot.score == null
    ? null
    : getPressureShiftDisplay(snapshot.score);

  return (
    <article className={cn("relative h-full overflow-hidden rounded-2xl border bg-card", isCompact ? "p-4 sm:p-5" : "p-4 sm:p-6")}>
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
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              snapshot.directionUi.badgeClass,
            )}
          >
            {snapshot.directionUi.label}
          </span>
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              snapshot.pressureUi.badgeClass,
            )}
          >
            {snapshot.pressureUi.label}
          </span>
          {gauge?.flightToQuality && (
            <span className="inline-flex rounded-full border border-amber-600/35 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-500/40 dark:text-amber-300">
              FTQ {Math.round(gauge.flightIntensity)}%
            </span>
          )}
        </header>

        <div className={cn("grid", isCompact ? "gap-4 2xl:grid-cols-[minmax(0,1.12fr)_minmax(15rem,0.88fr)]" : "gap-5 lg:grid-cols-[1.2fr_1fr]")}>
          <div className="flex h-full flex-col gap-4">
            <h3
              className={cn(
                isCompact ? "text-3xl font-black leading-[0.94] tracking-tight md:text-4xl 2xl:text-5xl" : "text-3xl font-black tracking-tight sm:text-5xl",
                snapshot.pressureUi.headlineClass,
              )}
            >
              {snapshot.headline}
            </h3>
            <p className={cn("text-sm text-muted-foreground", isCompact ? "max-w-[34rem]" : undefined)}>
              {snapshot.description}
            </p>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Minted 24h
                </p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {formatCurrency(snapshot.mint24h)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Burned 24h
                </p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-red-700 dark:text-red-400">
                  <TrendingDown className="h-3.5 w-3.5" />
                  {formatCurrency(snapshot.burn24h)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net 24h
                </p>
                <p
                  className={cn(
                    "mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold",
                    getNetColor(snapshot.net24h),
                  )}
                >
                  <Flame className="h-3.5 w-3.5" />
                  {formatSignedCurrency(snapshot.net24h)}
                </p>
              </div>
            </div>

            <div className={cn(isCompact ? "hidden 2xl:grid 2xl:grid-cols-3 2xl:gap-2" : "hidden gap-2 sm:grid-cols-3 lg:grid")}>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Minted 7d
                </p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {formatMaybeCurrency(snapshot.mint7d)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Burned 7d
                </p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold text-red-700 dark:text-red-400">
                  <TrendingDown className="h-3.5 w-3.5" />
                  {formatMaybeCurrency(snapshot.burn7d)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net 7d
                </p>
                <p
                  className={cn(
                    "mt-1 flex items-center gap-1.5 font-mono text-sm font-semibold",
                    getNetColor(snapshot.net7d),
                  )}
                >
                  <Flame className="h-3.5 w-3.5" />
                  {formatSignedCurrency(snapshot.net7d)}
                </p>
              </div>
            </div>

            <div className={cn("mt-auto space-y-2 rounded-xl border p-3", snapshot.pressureUi.panelClass)}>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <MethodologyLabel topic="bankRunGauge">Bank Run Gauge (pressure vs 30D)</MethodologyLabel>
                <span className="font-mono">
                  {gaugeDisplay == null
                    ? "NR"
                    : `${getNetPrefix(gaugeDisplay)}${gaugeDisplay} / 100`}
                </span>
              </div>
              <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
                <div
                  className="h-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, #ef4444 0%, #f59e0b 35%, #84cc16 65%, #10b981 100%)",
                  }}
                />
                {snapshot.leverPct !== null && (
                  <div
                    className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
                    style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
                    role="img"
                    aria-label={`Bank Run Gauge at ${Math.round(snapshot.leverPct)}%`}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                The gauge is a market-cap-weighted pressure-shift signal, not a literal mint-vs-burn direction meter.
              </p>
            </div>
          </div>

          <div className="flex h-full flex-col gap-3">
            <FlowMachineScene
              size={isCompact ? "mini" : "full"}
              mode={snapshot.directionUi.sceneMode}
              intensity={sceneIntensity}
              statusText={snapshot.directionUi.label}
              title={isCompact ? undefined : snapshot.directionUi.sceneTitle}
              subText={isCompact ? undefined : `Tracking ${snapshot.trackedCoins} stablecoins`}
              accentHex={snapshot.directionUi.accentHex}
              stress={sceneStress}
            />
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Top minter
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {snapshot.topMint ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {snapshot.topMint.symbol} +{formatCurrency(snapshot.topMint.netFlow24hUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None in this window</span>
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Top burner
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {snapshot.topBurn ? (
                      <span className="text-red-700 dark:text-red-400">
                        {snapshot.topBurn.symbol} {formatCurrency(snapshot.topBurn.netFlow24hUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None in this window</span>
                    )}
                  </p>
                </div>
              </div>
              <MintingPressureGauge
                mintVolume24hUsd={snapshot.mint24h}
                burnVolume24hUsd={snapshot.burn24h}
                className={isCompact ? undefined : "mt-auto"}
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export function FlowBrrrOverview({
  gauge,
  coins,
  weeklyHourly,
  isLoading,
  className,
  variant = "default",
}: FlowBrrrOverviewProps) {
  const snapshot = useMemo(
    () => buildSnapshot(gauge, coins, weeklyHourly),
    [gauge, coins, weeklyHourly],
  );

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className={cn("h-full space-y-4", className)}>
      <IterationOne snapshot={snapshot} gauge={gauge} variant={variant} />
    </div>
  );
}
