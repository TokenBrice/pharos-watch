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
import { useMintBurnFlows, useMintBurnFlowsCoin } from "@/hooks/use-mint-burn-flows";
import { formatCurrency, getNetColor, getNetPrefix } from "@/lib/format";
import { getFlowIntensityDisplay, getFlowIntensityMagnitude } from "@/lib/flow-intensity";
import { getMintBurnSummaryTimeframe, getNetFlowForHours } from "@/lib/mint-burn-timeframes";
import { GAUGE_BANDS } from "@/components/flow-gauge";
import { cn } from "@/lib/utils";

function getBandForScore(score: number): string {
  if (score < -70) return "CRISIS";
  if (score < -40) return "STRESS";
  if (score < -10) return "CAUTIOUS";
  if (score < 10) return "NEUTRAL";
  if (score < 40) return "HEALTHY";
  if (score < 70) return "CONFIDENT";
  return "SURGE";
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
  const signedIntensityDisplay = intensity != null
    ? getFlowIntensityDisplay(intensity)
    : null;
  const intensityMagnitude = signedIntensityDisplay != null
    ? getFlowIntensityMagnitude(signedIntensityDisplay)
    : 0;
  const isNegativeIntensity = (signedIntensityDisplay ?? 0) < 0;
  const sceneMode = isNegativeIntensity ? "shredder" : "printer";
  const sceneStatus = signedIntensityDisplay != null
    ? `${getNetPrefix(signedIntensityDisplay)}${signedIntensityDisplay}%`
    : "NR";
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
            <FlowMachineScene
              size="mini"
              mode={sceneMode}
              intensity={signedIntensityDisplay == null ? 0 : intensityMagnitude / 100}
              statusText={sceneStatus}
              title={sceneMode === "shredder" ? "Shredder" : "Printer"}
              accentHex={bandConfig?.hex}
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
                  <p className={cn("font-mono text-2xl font-black leading-none", getNetColor(signedIntensityDisplay ?? 0))}>
                    {signedIntensityDisplay != null ? `${getNetPrefix(signedIntensityDisplay)}${signedIntensityDisplay}` : "NR"}
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
                  <span className="font-mono text-xs text-muted-foreground">NR</span>
                )}
              </div>
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted">
                <div className="relative h-full w-1/2 border-r border-border/70">
                  {isNegativeIntensity && intensityMagnitude > 0 && (
                    <div
                      className="absolute right-0 top-0 h-full bg-red-500 transition-all duration-500"
                      style={{ width: `${intensityMagnitude}%` }}
                    />
                  )}
                </div>
                <div className="relative h-full w-1/2">
                  {!isNegativeIntensity && intensityMagnitude > 0 && (
                    <div
                      className="absolute left-0 top-0 h-full bg-blue-500 transition-all duration-500"
                      style={{ width: `${intensityMagnitude}%` }}
                    />
                  )}
                </div>
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
