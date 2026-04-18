"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { Skeleton } from "@/components/ui/skeleton";
import { FlowMachineScene } from "@/components/flow-machine-scene";
import { MintingPressureGauge } from "@/components/minting-pressure-gauge";
import {
  useMintBurnFlows,
  useMintBurnFlowsCoin,
} from "@/hooks/use-mint-burn-flows";
import {
  formatSignedCurrency,
  getNetColor,
  getNetPrefix,
} from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import {
  getMintBurnSummaryTimeframe,
  getNetFlowForHours,
} from "@/lib/mint-burn-timeframes";
import { THIRTY_DAYS_HOURS, NINETY_DAYS_HOURS } from "@/lib/constants";
import {
  buildFlowSummaryNarrative,
  getFlowDirectionUi,
  getFlowPressureUi,
} from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import {
  inferHas24hActivity,
  resolveNetDirection,
  resolvePressureScore,
  resolvePressureState,
} from "@/lib/mint-burn-coin-helpers";
import { clamp } from "@shared/lib/math";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

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

  return `${prefix}: ${formatSignedCurrency(baselineDailyNetUsd)}${daysSuffix}.`;
}

interface FlowSummaryCardProps {
  stablecoinId: string;
}

function SummarySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="pharos-kicker">
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
  const netSignal = getFlowDirectionUi(netDirection, "summary");
  const pressureSignal = getFlowPressureUi(pressureState, "summary");
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
        <CardTitle as="h3" className={DETAIL_SECTION_TITLE_CLASS}>
          <MethodologyLabel topic="mintBurnFlows">Mint &amp; Burn Flows</MethodologyLabel>
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
                className="pharos-focus-ring inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
                      {formatSignedCurrency(coin.netFlow24hUsd)}
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
                      <MethodologyLabel topic="pressureShift">Pressure Shift vs 30D</MethodologyLabel>
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
                {buildFlowSummaryNarrative(netDirection, pressureState)}
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
                  {formatSignedCurrency(shortNetFlow)}
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
                  {formatSignedCurrency(longNetFlow)}
                </p>
              </div>
              {/* Only render the fixed 30d/90d tiles when the coin's custom
                  timeframe isn't already showing those exact windows, otherwise
                  we surface the same metric twice. */}
              {timeframe.shortHours !== THIRTY_DAYS_HOURS && timeframe.longHours !== THIRTY_DAYS_HOURS && (
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
                    {formatSignedCurrency(coin.netFlow30dUsd)}
                  </p>
                </div>
              )}
              {timeframe.shortHours !== NINETY_DAYS_HOURS && timeframe.longHours !== NINETY_DAYS_HOURS && (
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
                    {formatSignedCurrency(coin.netFlow90dUsd)}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        <MethodologyCardActions topic="mintBurnFlows" />
      </CardContent>
    </Card>
  );
}
