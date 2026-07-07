"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MintingPressureArcGauge,
  getLiteralMintingPressureUi,
} from "@/components/minting-pressure-gauge";
import { getLiteralMintingPressureScore } from "@shared/lib/mint-burn-signals";
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
  resolveFlowWindow,
} from "@/lib/mint-burn-timeframes";
import { THIRTY_DAYS_HOURS, NINETY_DAYS_HOURS } from "@/lib/constants";
import {
  buildFlowSummaryNarrative,
  getFlowDirectionUi,
  getFlowPressureUi,
} from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import {
  resolveNetDirection,
  resolvePressureScore,
  resolvePressureState,
} from "@/lib/mint-burn-coin-helpers";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

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

  const { shortNetFlow, longNetFlow } = resolveFlowWindow(
    coin,
    timeframe,
    shortWindowData?.netFlowUsd,
    longWindowData?.netFlowUsd,
  );

  const netDirection = resolveNetDirection(coin);
  const pressureScore = resolvePressureScore(coin);
  const pressureState = resolvePressureState(coin);
  const pressureDisplay = pressureScore != null
    ? getPressureShiftDisplay(pressureScore)
    : null;
  const netSignal = getFlowDirectionUi(netDirection, "summary");
  const pressureSignal = getFlowPressureUi(pressureState, "summary");
  const gaugeUi = getLiteralMintingPressureUi(
    getLiteralMintingPressureScore({
      mintVolume24hUsd: coin.mintVolume24hUsd,
      burnVolume24hUsd: coin.burnVolume24hUsd,
    }),
  );

  // Figma coin template: quadrant layout with hairline-divided regions —
  // [Minting Pressure gauge | Net window grid] over [Pressure Shift | Avg
  // Daily Net] — no nested cards.
  // Cell labels are the bare windows ("24H", "7D", …) — the quadrant header
  // already says "Net" (Figma coin template).
  const netCells: { label: string; value: number }[] = [
    { label: timeframe.shortLabel, value: shortNetFlow },
    { label: timeframe.longLabel, value: longNetFlow },
  ];
  if (timeframe.shortHours !== THIRTY_DAYS_HOURS && timeframe.longHours !== THIRTY_DAYS_HOURS) {
    netCells.push({ label: "30d", value: coin.netFlow30dUsd });
  }
  if (timeframe.shortHours !== NINETY_DAYS_HOURS && timeframe.longHours !== NINETY_DAYS_HOURS) {
    netCells.push({ label: "90d", value: coin.netFlow90dUsd });
  }

  return (
    <Card className="pharos-card-shell gap-0 overflow-hidden py-0">
      <div className="border-b border-border/40 px-4 py-3 sm:px-5">
        <DetailSectionTitle as="h3">
          <MethodologyLabel topic="mintBurnFlows">Mint &amp; Burn Flows</MethodologyLabel>
        </DetailSectionTitle>
      </div>

      <div className="grid border-b border-border/40 lg:grid-cols-2 lg:divide-x lg:divide-border/40">
        {/* Minting Pressure quadrant */}
        <div className="flex flex-col border-b border-border/40 lg:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
            <p className="text-sm font-medium text-foreground">
              Minting Pressure <span className="text-muted-foreground">· 24h</span>
            </p>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                gaugeUi.badgeClass,
              )}
            >
              {gaugeUi.label}
            </span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-6 sm:px-5">
            <MintingPressureArcGauge
              mintVolume24hUsd={coin.mintVolume24hUsd}
              burnVolume24hUsd={coin.burnVolume24hUsd}
            />
            <p className="mt-3 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
              The gauge uses raw 24h mint and burn volume balance
            </p>
          </div>
        </div>

        {/* Net window quadrant */}
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
            <p className="text-sm font-medium text-foreground">Net</p>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                netSignal.badgeClass,
              )}
            >
              {netSignal.label}
            </span>
          </div>
          <div className="grid flex-1 grid-cols-2">
            {netCells.map((cell, index) => (
              <div
                key={cell.label}
                className={cn(
                  "px-4 py-4 sm:px-5",
                  index % 2 === 0 && "border-r border-border/40",
                  index < netCells.length - 2 && "border-b border-border/40",
                )}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {cell.label}
                </p>
                <p
                  className={cn(
                    "mt-1.5 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
                    getNetColor(cell.value),
                  )}
                >
                  {formatSignedCurrency(cell.value)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-border/40">
        {/* Pressure Shift quadrant */}
        <div className="border-b border-border/40 px-4 py-4 sm:px-5 lg:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              <MethodologyLabel topic="pressureShift">Pressure Shift</MethodologyLabel>{" "}
              <span className="text-muted-foreground">· 30d</span>
            </p>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                pressureSignal.badgeClass,
              )}
            >
              {pressureSignal.label}
            </span>
          </div>
          <p
            className={cn(
              "mt-2 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
              pressureSignal.valueClass,
            )}
          >
            {pressureDisplay != null ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}` : "NR"}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            {pressureSignal.helper}
          </p>
        </div>

        {/* Average Daily Net quadrant */}
        <div className="px-4 py-4 sm:px-5">
          <p className="text-sm font-medium text-foreground">
            Average Daily Net <span className="text-muted-foreground">· 30d</span>
          </p>
          <p
            className={cn(
              "mt-2 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
              coin.baselineDailyNetUsd != null ? getNetColor(coin.baselineDailyNetUsd) : "text-muted-foreground",
            )}
          >
            {coin.baselineDailyNetUsd != null ? formatSignedCurrency(coin.baselineDailyNetUsd) : "NR"}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            {buildFlowSummaryNarrative(netDirection, pressureState)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-2 sm:px-5">
        <MethodologyCardActions topic="mintBurnFlows" className="mt-0" />
        <Link
          href="/flows/"
          className="pharos-focus-ring inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          View all flows
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </Card>
  );
}
