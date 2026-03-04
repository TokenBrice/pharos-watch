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
import { useMintBurnFlows, useMintBurnFlowsCoin } from "@/hooks/use-mint-burn-flows";
import { formatCurrency, getNetColor, getNetPrefix } from "@/lib/format";
import { getMintBurnSummaryTimeframe, getNetFlowForHours } from "@/lib/mint-burn-timeframes";
import { GAUGE_BANDS } from "@/components/flow-gauge";

function getBandForScore(score: number): string {
  if (score < 15) return "CRISIS";
  if (score < 30) return "STRESS";
  if (score < 45) return "CAUTIOUS";
  if (score < 55) return "NEUTRAL";
  if (score < 70) return "HEALTHY";
  if (score < 85) return "CONFIDENT";
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
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 flex-1 rounded-full" />
          <Skeleton className="h-5 w-10" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
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
  const shortMintVolume = needsCustomShortWindow
    ? (shortWindowData?.mintVolumeUsd ?? Number.NaN)
    : coin.mintVolume24hUsd;
  const shortBurnVolume = needsCustomShortWindow
    ? (shortWindowData?.burnVolumeUsd ?? Number.NaN)
    : coin.burnVolume24hUsd;

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
      <CardContent className="space-y-4">
        {/* Flow Intensity bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Flow Intensity</span>
            {intensity != null && bandConfig ? (
              <span className={bandConfig.textClass}>{bandConfig.label}</span>
            ) : (
              <span>&mdash;</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
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
            <span className="font-mono tabular-nums text-sm font-semibold w-8 text-right">
              {intensityDisplay != null ? intensityDisplay : "\u2014"}
            </span>
          </div>
        </div>

        {/* Net flows */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Net {timeframe.shortLabel}</p>
            <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(shortNetFlow)}`}>
              {getNetPrefix(shortNetFlow)}{formatCurrency(shortNetFlow)}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Net {timeframe.longLabel}</p>
            <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(longNetFlow)}`}>
              {getNetPrefix(longNetFlow)}{formatCurrency(longNetFlow)}
            </p>
          </div>
        </div>

        {/* Mint / Burn volume breakdown */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Minted {timeframe.shortLabel}</p>
            <p className="font-mono tabular-nums text-sm text-emerald-500">
              {formatCurrency(shortMintVolume)}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Burned {timeframe.shortLabel}</p>
            <p className="font-mono tabular-nums text-sm text-red-500">
              {formatCurrency(shortBurnVolume)}
            </p>
          </div>
        </div>

        {/* Link to flows page */}
        <Link
          href="/flows"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View all flows
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
