"use client";

import Link from "next/link";
import { ArrowRight, Flame } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyStateIllustration } from "@/components/empty-state-illustration";
import { MintingPressureArcGauge } from "@/components/minting-pressure-gauge";
import { getLiteralMintingPressureScore } from "@shared/lib/mint-burn-signals";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatSignedCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildFlowSummaryNarrative, getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import { resolveNetDirection, resolvePressureScore, resolvePressureState } from "@/lib/mint-burn-coin-helpers";
import { MethodologyCardActions, MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

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

/**
 * The em-dash reading the Safety rail already uses for an unavailable metric.
 * Deliberately lighter than the measured figure it replaces: an unreported stat
 * must not read as a value of the same standing.
 */
function UnreportedStat() {
  return (
    <p className="mt-2 pharos-numeric text-2xl font-normal leading-none text-muted-foreground sm:text-3xl">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not reported</span>
    </p>
  );
}

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  const query = useMintBurnFlows();
  const { data, isLoading } = query;

  if (isLoading && !data) {
    return <SummarySkeleton />;
  }

  if (query.error && !data) {
    return (
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader>
          <StablecoinModuleTitle as="h3" className={DETAIL_MODULE_TITLE_CLASS}>
            Mint &amp; Burn Flows
          </StablecoinModuleTitle>
        </CardHeader>
        <CardContent>
          <QueryStateNotice state="unavailable" label="Mint and burn flow data" onRetry={() => void query.refetch()} />
        </CardContent>
      </Card>
    );
  }

  if (!data?.coins) return null;

  const coin = data.coins.find((entry) => entry.stablecoinId === stablecoinId);
  if (!coin) return null;

  const netDirection = resolveNetDirection(coin);
  const pressureScore = resolvePressureScore(coin);
  const pressureState = resolvePressureState(coin);
  const pressureDisplay = pressureScore != null ? getPressureShiftDisplay(pressureScore) : null;
  const netSignal = getFlowDirectionUi(netDirection, "summary");
  const pressureSignal = getFlowPressureUi(pressureState, "summary");
  // A dial with a needle asserts a measurement. When no 24h volume was counted
  // there is nothing to weigh, so the quadrant takes the same empty-state
  // treatment the flow-history feed two modules below already uses.
  const hasMintingPressure =
    getLiteralMintingPressureScore({
      mintVolume24hUsd: coin.mintVolume24hUsd,
      burnVolume24hUsd: coin.burnVolume24hUsd,
    }) != null;

  // Figma coin template: quadrant layout with hairline-divided regions —
  // [Minting Pressure gauge | Net window grid] over [Pressure Shift | Avg
  // Daily Net] — no nested cards.
  // Cell labels are the bare windows ("24H", "7D", …) — the quadrant header
  // already says "Net" (Figma coin template).
  const netCells: { label: string; value: number }[] = [
    { label: "24h", value: coin.netFlow24hUsd },
    { label: "7d", value: coin.netFlow7dUsd },
    { label: "30d", value: coin.netFlow30dUsd },
    { label: "90d", value: coin.netFlow90dUsd },
  ];

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-4 sm:px-5">
        <StablecoinModuleTitle as="h3" className={DETAIL_MODULE_TITLE_CLASS}>
          Mint &amp; Burn Flows
        </StablecoinModuleTitle>
        <div className="flex items-center gap-2">
        <FreshnessIndicator
          compact
          updatedAtMs={query.dataUpdatedAt}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * 1000}
          labelPrefix="Updated"
        />
        <MethodologyHint
          topic="mintBurnFlows"
          buttonClassName="!h-5 !min-h-0 !w-5 rounded-md !border-border/60 !bg-muted/50 !text-muted-foreground hover:!border-border hover:!bg-muted hover:!text-foreground dark:!border-border/60 dark:!bg-muted/50 dark:!text-muted-foreground md:!h-5 md:!w-5 md:!min-h-0"
        />
        </div>
      </div>

      {query.error ? (
        <div className="border-b border-border/40 px-4 py-3 sm:px-5">
          <QueryStateNotice
            state="stale-with-data"
            label="Mint and burn flow data"
            dataUpdatedAt={query.dataUpdatedAt}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : null}

      <div className="grid border-b border-border/40 lg:grid-cols-2 lg:divide-x lg:divide-border/40">
        {/* Minting Pressure quadrant */}
        <div className="flex flex-col border-b border-border/40 lg:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
            <p className="text-sm font-medium text-foreground">
              Minting Pressure <span className="text-muted-foreground">· 24h</span>
            </p>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                netSignal.badgeClass,
              )}
            >
              {netDirection === "burning" ? <Flame className="h-3 w-3" aria-hidden="true" /> : null}
              {netSignal.label}
            </span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-6 sm:px-5">
            {hasMintingPressure ? (
              <>
                <MintingPressureArcGauge
                  mintVolume24hUsd={coin.mintVolume24hUsd}
                  burnVolume24hUsd={coin.burnVolume24hUsd}
                />
                <p className="mt-3 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
                  The gauge uses raw 24h mint and burn volume balance
                </p>
              </>
            ) : (
              <EmptyStateIllustration
                kind="no-data"
                title="No 24h mint or burn volume"
                description="There is nothing to weigh, so no minting-pressure reading is published."
                className="py-2"
              />
            )}
          </div>
        </div>

        {/* Net window quadrant — no direction chip here: the Minting Pressure
            header already carries it (Figma coin template). */}
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
            <p className="text-sm font-medium text-foreground">Net</p>
          </div>
          <div className="grid flex-1 grid-cols-2">
            {netCells.map((cell, index) => (
              <div
                key={cell.label}
                className={cn(
                  "px-4 py-4 sm:px-5",
                  index % 2 === 0 && "border-r border-border/40",
                  index < 2 && "border-b border-border/40",
                )}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{cell.label}</p>
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
          {pressureDisplay != null ? (
            <p
              className={cn(
                "mt-2 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
                pressureSignal.valueClass,
              )}
            >
              {`${getNetPrefix(pressureDisplay)}${pressureDisplay}`}
            </p>
          ) : (
            <UnreportedStat />
          )}
          <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            {pressureSignal.helper}
          </p>
        </div>

        {/* Average Daily Net quadrant */}
        <div className="px-4 py-4 sm:px-5">
          <p className="text-sm font-medium text-foreground">
            Average Daily Net <span className="text-muted-foreground">· 30d</span>
          </p>
          {coin.baselineDailyNetUsd != null ? (
            <p
              className={cn(
                "mt-2 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
                getNetColor(coin.baselineDailyNetUsd),
              )}
            >
              {formatSignedCurrency(coin.baselineDailyNetUsd)}
            </p>
          ) : (
            <UnreportedStat />
          )}
          <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            {buildFlowSummaryNarrative(netDirection, pressureState)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-2 sm:px-5">
        <MethodologyCardActions topic="mintBurnFlows" className="mt-0 border-t-0 pt-0" />
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
