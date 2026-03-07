"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FlowMachineScene } from "@/components/flow-machine-scene";
import { MintingPressureGauge } from "@/components/minting-pressure-gauge";
import {
  useMintBurnFlows,
  useMintBurnFlowsCoin,
} from "@/hooks/use-mint-burn-flows";
import {
  formatCurrency,
  getNetColor,
  getNetPrefix,
} from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import {
  getMintBurnSummaryTimeframe,
  getNetFlowForHours,
} from "@/lib/mint-burn-timeframes";
import { cn } from "@/lib/utils";
import type { MintBurnCoinFlow } from "@shared/types";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function inferHas24hActivity(coin: MintBurnCoinFlow): boolean {
  if (coin.has24hActivity !== undefined) {
    return coin.has24hActivity;
  }
  return Boolean(
    coin.mintCount24h
    || coin.burnCount24h
    || coin.mintVolume24hUsd
    || coin.burnVolume24hUsd
    || coin.netFlow24hUsd,
  );
}

function resolveNetDirection(coin: MintBurnCoinFlow): NetFlowDirection24h {
  return coin.netFlowDirection24h
    ?? getNetFlowDirection24h({
      netFlow24hUsd: coin.netFlow24hUsd,
      has24hActivity: inferHas24hActivity(coin),
    });
}

function resolvePressureScore(coin: MintBurnCoinFlow): number | null {
  return coin.pressureShiftScore ?? coin.flowIntensity;
}

function resolvePressureState(coin: MintBurnCoinFlow): PressureShiftState {
  return coin.pressureShiftState ?? getPressureShiftState(resolvePressureScore(coin));
}

const NET_SIGNAL_UI: Record<
  NetFlowDirection24h,
  {
    label: string;
    badgeClass: string;
    valueClass: string;
    accentHex: string;
    helper: string;
    sceneMode: "printer" | "shredder";
    sceneTitle: string;
  }
> = {
  minting: {
    label: "Minting",
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    valueClass: "text-emerald-700 dark:text-emerald-400",
    accentHex: "#22c55e",
    helper: "Net issuance dominates the last 24 hours.",
    sceneMode: "printer",
    sceneTitle: "Printer",
  },
  burning: {
    label: "Burning",
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: "text-red-700 dark:text-red-400",
    accentHex: "#ef4444",
    helper: "Net redemptions dominate the last 24 hours.",
    sceneMode: "shredder",
    sceneTitle: "Shredder",
  },
  flat: {
    label: "Flat",
    badgeClass:
      "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
    accentHex: "#6b7280",
    helper: "Mints and burns offset each other in the active window.",
    sceneMode: "printer",
    sceneTitle: "Flow Desk",
  },
  inactive: {
    label: "No activity",
    badgeClass:
      "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
    accentHex: "#6b7280",
    helper: "No mint or burn events were recorded in the active window.",
    sceneMode: "printer",
    sceneTitle: "Flow Desk",
  },
};

const PRESSURE_SIGNAL_UI: Record<
  PressureShiftState,
  {
    label: string;
    badgeClass: string;
    valueClass: string;
    helper: string;
  }
> = {
  improving: {
    label: "Improving",
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    valueClass: "text-emerald-700 dark:text-emerald-400",
    helper: "Current pressure is lighter than this coin's recent norm.",
  },
  stable: {
    label: "Stable vs 30D",
    badgeClass:
      "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
    helper: "Current pressure is close to the 30-day baseline.",
  },
  worsening: {
    label: "Worsening",
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: "text-red-700 dark:text-red-400",
    helper: "Current pressure is harsher than the recent baseline.",
  },
  nr: {
    label: "NR",
    badgeClass:
      "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
    helper: "Needs at least 7 tracked days plus current activity.",
  },
};

function buildNarrative(
  direction: NetFlowDirection24h,
  pressureState: PressureShiftState,
): string {
  if (direction === "inactive") {
    return "No current activity; pressure shift is NR.";
  }

  if (pressureState === "nr") {
    if (direction === "burning") {
      return "Burning now; pressure shift is NR until enough history accumulates.";
    }
    if (direction === "minting") {
      return "Minting now; pressure shift is NR until enough history accumulates.";
    }
    return "Flows are flat; pressure shift is NR until enough history accumulates.";
  }

  if (direction === "burning" && pressureState === "improving") {
    return "Burning, but pressure is easing versus its baseline.";
  }
  if (direction === "burning" && pressureState === "stable") {
    return "Burning at roughly its usual redemption pace.";
  }
  if (direction === "burning" && pressureState === "worsening") {
    return "Burning, with pressure worsening versus the baseline.";
  }
  if (direction === "minting" && pressureState === "improving") {
    return "Minting, with issuance running stronger than its usual pace.";
  }
  if (direction === "minting" && pressureState === "stable") {
    return "Minting at roughly its usual 30D issuance pace.";
  }
  if (direction === "minting" && pressureState === "worsening") {
    return "Minting, but weaker than its usual 30D issuance pace.";
  }
  if (pressureState === "improving") {
    return "Flows are flat, but pressure is stronger than the baseline.";
  }
  if (pressureState === "stable") {
    return "Flows are flat and close to the baseline.";
  }
  return "Flows are flat, but pressure is weaker than the baseline.";
}

function getBaselineCaption(
  baselineDailyNetUsd: number | null | undefined,
  baselineDataDays: number | null | undefined,
): string | null {
  if (baselineDailyNetUsd == null) {
    return null;
  }

  const prefix = baselineDataDays === 30
    ? "30D avg daily net"
    : "Baseline avg daily net";
  const daysSuffix =
    baselineDataDays && baselineDataDays !== 30
      ? ` across ${baselineDataDays} tracked day${baselineDataDays === 1 ? "" : "s"}`
      : "";

  return `${prefix}: ${getNetPrefix(baselineDailyNetUsd)}${formatCurrency(baselineDailyNetUsd)}${daysSuffix}.`;
}

interface FlowSummaryCardProps {
  stablecoinId: string;
}

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
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
            </div>
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

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  const timeframe = getMintBurnSummaryTimeframe(stablecoinId);
  const needsCustomShortWindow = timeframe.shortHours !== 24;
  const needsCustomLongWindow = timeframe.longHours !== 7 * 24;
  const shouldFetchLongWindow =
    needsCustomLongWindow && timeframe.longHours !== timeframe.shortHours;

  const { data, isLoading } = useMintBurnFlows();
  const { data: shortWindowData, isLoading: isShortWindowLoading } =
    useMintBurnFlowsCoin(stablecoinId, timeframe.shortHours, {
      enabled: needsCustomShortWindow,
    });
  const { data: longWindowData, isLoading: isLongWindowLoading } =
    useMintBurnFlowsCoin(stablecoinId, timeframe.longHours, {
      enabled: shouldFetchLongWindow,
    });

  if (
    isLoading
    || (needsCustomShortWindow && isShortWindowLoading)
    || (shouldFetchLongWindow && isLongWindowLoading)
  ) {
    return <SummarySkeleton />;
  }

  if (!data?.coins) return null;

  const coin = data.coins.find((entry) => entry.stablecoinId === stablecoinId);
  if (!coin) return null;

  const fallbackShortNetFlow =
    getNetFlowForHours(coin, timeframe.shortHours) ?? coin.netFlow24hUsd;
  const fallbackLongNetFlow =
    getNetFlowForHours(coin, timeframe.longHours) ?? coin.netFlow7dUsd;
  const shortNetFlowCandidate = needsCustomShortWindow
    ? (shortWindowData?.netFlowUsd ?? fallbackShortNetFlow)
    : coin.netFlow24hUsd;
  const longNetFlowCandidate = needsCustomLongWindow
    ? (
      shouldFetchLongWindow
        ? (longWindowData?.netFlowUsd ?? fallbackLongNetFlow)
        : shortNetFlowCandidate
    )
    : coin.netFlow7dUsd;

  const shortNetFlow = Number.isFinite(shortNetFlowCandidate)
    ? shortNetFlowCandidate
    : coin.netFlow24hUsd;
  const longNetFlow = Number.isFinite(longNetFlowCandidate)
    ? longNetFlowCandidate
    : coin.netFlow7dUsd;

  const has24hActivity = inferHas24hActivity(coin);
  const netDirection = resolveNetDirection(coin);
  const pressureScore = resolvePressureScore(coin);
  const pressureState = resolvePressureState(coin);
  const pressureDisplay = pressureScore != null
    ? getPressureShiftDisplay(pressureScore)
    : null;
  const netSignal = NET_SIGNAL_UI[netDirection];
  const pressureSignal = PRESSURE_SIGNAL_UI[pressureState];
  const baselineCaption = getBaselineCaption(
    coin.baselineDailyNetUsd,
    coin.baselineDataDays,
  );

  const total24hVolume = coin.mintVolume24hUsd + coin.burnVolume24hUsd;
  const relativeDirectionStrength = has24hActivity
    ? Math.abs(coin.netFlow24hUsd) / Math.max(total24hVolume, 1)
    : 0.08;
  const sceneIntensity = netDirection === "flat"
    ? 0.12
    : clamp(relativeDirectionStrength, 0.12, 1);
  const sceneStatus = netSignal.label;
  const sceneSubText = pressureState === "nr"
    ? "Pressure shift NR"
    : `Pressure ${pressureSignal.label.toLowerCase()}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-sm">
          Mint &amp; Burn Flows
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="flex h-full flex-col gap-3">
            <FlowMachineScene
              size="mini"
              mode={netSignal.sceneMode}
              intensity={sceneIntensity}
              statusText={sceneStatus}
              title={netSignal.sceneTitle}
              subText={sceneSubText}
              accentHex={netSignal.accentHex}
            />
            <div className="mt-auto space-y-2">
              <MintingPressureGauge
                mintVolume24hUsd={coin.mintVolume24hUsd}
                burnVolume24hUsd={coin.burnVolume24hUsd}
              />
              <Link
                href="/flows"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                View all flows
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-background/35 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Net 24h</p>
                    <p
                      className={cn(
                        "mt-1 font-mono text-2xl font-black leading-none",
                        netSignal.valueClass,
                      )}
                    >
                      {getNetPrefix(coin.netFlow24hUsd)}
                      {formatCurrency(coin.netFlow24hUsd)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                      netSignal.badgeClass,
                    )}
                  >
                    {netSignal.label}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {netSignal.helper}
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-background/35 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Pressure Shift vs 30D
                    </p>
                    <p
                      className={cn(
                        "mt-1 font-mono text-2xl font-black leading-none",
                        pressureSignal.valueClass,
                      )}
                    >
                      {pressureDisplay != null
                        ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
                        : "NR"}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                      pressureSignal.badgeClass,
                    )}
                  >
                    {pressureSignal.label}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {pressureSignal.helper}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <p className="text-sm text-foreground">
                {buildNarrative(netDirection, pressureState)}
              </p>
              {baselineCaption ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {baselineCaption}
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 rounded-lg border border-border/60 bg-background/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net {timeframe.shortLabel}
                </p>
                <p
                  className={cn(
                    "font-mono tabular-nums text-sm font-semibold",
                    getNetColor(shortNetFlow),
                  )}
                >
                  {getNetPrefix(shortNetFlow)}
                  {formatCurrency(shortNetFlow)}
                </p>
              </div>
              <div className="space-y-1 rounded-lg border border-border/60 bg-background/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net {timeframe.longLabel}
                </p>
                <p
                  className={cn(
                    "font-mono tabular-nums text-sm font-semibold",
                    getNetColor(longNetFlow),
                  )}
                >
                  {getNetPrefix(longNetFlow)}
                  {formatCurrency(longNetFlow)}
                </p>
              </div>
              <div className="space-y-1 rounded-lg border border-border/60 bg-background/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net 30d
                </p>
                <p
                  className={cn(
                    "font-mono tabular-nums text-sm font-semibold",
                    getNetColor(coin.netFlow30dUsd),
                  )}
                >
                  {getNetPrefix(coin.netFlow30dUsd)}
                  {formatCurrency(coin.netFlow30dUsd)}
                </p>
              </div>
              <div className="space-y-1 rounded-lg border border-border/60 bg-background/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Net 90d
                </p>
                <p
                  className={cn(
                    "font-mono tabular-nums text-sm font-semibold",
                    getNetColor(coin.netFlow90dUsd),
                  )}
                >
                  {getNetPrefix(coin.netFlow90dUsd)}
                  {formatCurrency(coin.netFlow90dUsd)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
