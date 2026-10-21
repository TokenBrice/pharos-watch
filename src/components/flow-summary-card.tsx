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
import { getLiteralMintingPressureReading, type LiteralMintingPressureUnavailableReason } from "@shared/lib/mint-burn-signals";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatSignedCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { resolveMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildFlowSummaryNarrative, getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import {
  resolveBaselineDailyNetUsd,
  resolveCoinNetFlow,
  resolveNetDirection,
  resolvePressureScore,
  resolvePressureState,
  resolvePressureUnavailableNote,
} from "@shared/lib/mint-burn-coin-helpers";
import { describeUnpricedEvents, type MintBurnSignedNetView } from "@shared/lib/mint-burn-valuation-display";
import { FlowSignedNetValue } from "@/components/flow-valuation-value";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { resolveDetailFlowMeta } from "@/lib/stablecoin-detail-query-view-model";

interface FlowSummaryCardProps {
  stablecoinId: string;
}

function SummarySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="pharos-label">
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

function describeMintingPressureUnavailable(
  reason: LiteralMintingPressureUnavailableReason | "window-unavailable",
  window24h: ReturnType<typeof resolveMintBurnValuation>,
): { title: string; description: string } {
  switch (reason) {
    case "window-unavailable":
      return {
        title: "Minting pressure not rated",
        description: "Scan coverage of the 24h window is unknown, so no minting-pressure reading is published.",
      };
    case "valuation-partial":
      return {
        title: "Minting pressure not rated",
        description: `${describeUnpricedEvents(window24h)}, so the volumes are lower bounds and no minting-pressure reading is published.`,
      };
    case "valuation-unknown":
      return {
        title: "Minting pressure not rated",
        description: "Valuation coverage of the 24h window is unknown, so no minting-pressure reading is published.",
      };
    case "no-24h-volume":
      return {
        title: "No 24h mint or burn volume",
        description: "There is nothing to weigh, so no minting-pressure reading is published.",
      };
  }
}

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  const query = useMintBurnFlows();
  const { data, isLoading } = query;
  const coin = data?.coins?.find((entry) => entry.stablecoinId === stablecoinId);
  const healthInput = {
    ...DATA_HEALTH_PRESETS.mintBurnFlows,
    label: "Mint and burn flow data",
    dataUpdatedAt: query.dataUpdatedAt,
    meta: resolveDetailFlowMeta(query),
    error: query.error,
    hasData: !!coin,
  };
  const health = deriveDataHealth(healthInput, query.dataUpdatedAt);

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

  if (!coin) return null;

  const netDirection = resolveNetDirection(coin);
  const pressureScore = resolvePressureScore(coin);
  const pressureState = resolvePressureState(coin);
  const pressureUnavailableNote = resolvePressureUnavailableNote(coin);
  const pressureDisplay = pressureScore != null ? getPressureShiftDisplay(pressureScore) : null;
  const netSignal = getFlowDirectionUi(netDirection);
  const pressureSignal = getFlowPressureUi(pressureState);
  const baselineDailyNetUsd = resolveBaselineDailyNetUsd(coin);
  const window24h = resolveMintBurnValuation(coin.valuation?.window24h);
  // A dial with a needle asserts a measurement. With no counted 24h volume, or
  // with either side not fully valued (a balance of lower bounds is no bound,
  // v6.27), the quadrant takes the same empty-state treatment the flow-history
  // feed two modules below already uses, naming why.
  const mintingPressure = coin.has24hActivity === null
    || coin.coverage?.windows?.window24h.complete === false
    || (coin.netFlow24hUsd === null && window24h.completeness === "complete")
    ? { score: null, unavailableReason: "window-unavailable" as const }
    : getLiteralMintingPressureReading({
        mintVolume24hUsd: coin.mintVolume24hUsd,
        burnVolume24hUsd: coin.burnVolume24hUsd,
        mintCompleteness: window24h.mintCompleteness,
        burnCompleteness: window24h.burnCompleteness,
      });

  // Figma coin template: quadrant layout with hairline-divided regions —
  // [Minting Pressure gauge | Net window grid] over [Pressure Shift | Avg
  // Daily Net] — no nested cards.
  // Cell labels are the bare windows ("24H", "7D", …) — the quadrant header
  // already says "Net" (Figma coin template).
  const netCells: { label: string; net: MintBurnSignedNetView; hasWindow?: boolean }[] = [
    { label: "24h", net: resolveCoinNetFlow(coin, "24h") },
    { label: "7d", net: resolveCoinNetFlow(coin, "7d") },
    { label: "30d", net: resolveCoinNetFlow(coin, "30d"), hasWindow: coin.coverage?.has30dWindow },
    { label: "90d", net: resolveCoinNetFlow(coin, "90d"), hasWindow: coin.coverage?.has90dWindow },
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
          updatedAtMs={health.dataUpdatedAt}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * 1000}
          labelPrefix="Updated"
        />
        <MethodologyHint
          topic="mintBurnFlows"
          buttonClassName="!h-5 !min-h-0 !w-5 rounded-md !border-border/60 !bg-muted/50 !text-muted-foreground hover:!border-border hover:!bg-muted hover:!text-foreground dark:!border-border/60 dark:!bg-muted/50 dark:!text-muted-foreground md:!h-5 md:!w-5 md:!min-h-0"
        />
        </div>
      </div>

      <div className="empty:hidden border-b border-border/40 px-4 py-3 sm:px-5">
        <StaleDataBanner queries={[healthInput]} />
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
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold",
                netSignal.badgeClass,
              )}
            >
              {netDirection === "burning" ? <Flame className="h-3 w-3" aria-hidden="true" /> : null}
              {netSignal.label}
            </span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-6 sm:px-5">
            {mintingPressure.score != null ? (
              <>
                <MintingPressureArcGauge score={mintingPressure.score} />
                <p className="mt-3 max-w-[36ch] text-pretty text-center text-xs leading-relaxed text-muted-foreground">
                  The gauge uses raw 24h mint and burn volume balance
                </p>
              </>
            ) : (
              <div data-reason-codes={mintingPressure.unavailableReason}>
                <EmptyStateIllustration
                  kind="no-data"
                  {...describeMintingPressureUnavailable(mintingPressure.unavailableReason, window24h)}
                  className="py-2"
                />
              </div>
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
            {netCells.map((cell, index) => {
              const isPartial = cell.hasWindow === false && cell.net.valueUsd != null;
              return (
                <div
                  key={cell.label}
                  className={cn(
                    "px-4 py-4 sm:px-5",
                    index % 2 === 0 && "border-r border-border/40",
                    index < 2 && "border-b border-border/40",
                  )}
                  title={
                    isPartial
                      ? `${cell.label === "30d" ? "30-day" : "90-day"} window is incomplete; value reflects the covered portion only.`
                      : undefined
                  }
                >
                  <p className="pharos-label">
                    {cell.label}
                    {isPartial && <span className="ml-1">partial</span>}
                  </p>
                  <p
                    className={cn(
                      "mt-1.5 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
                      isPartial && "opacity-60",
                    )}
                  >
                    <FlowSignedNetValue
                      net={cell.net}
                      format={formatSignedCurrency}
                      colorClassName={getNetColor}
                      className={cell.net.valueUsd == null ? "font-normal" : undefined}
                    />
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-border/40">
        {/* Pressure Shift quadrant */}
        <div className="border-b border-border/40 px-4 py-4 sm:px-5 lg:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              <MethodologyLabel topic="pressureShift">Pressure shift</MethodologyLabel>{" "}
              <span className="text-muted-foreground">· 30d</span>
            </p>
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-2xs font-semibold",
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
          <p className="mt-2 text-pretty text-xs leading-relaxed text-muted-foreground">
            {pressureUnavailableNote ?? pressureSignal.helper}
          </p>
        </div>

        {/* Average Daily Net quadrant */}
        <div className="px-4 py-4 sm:px-5">
          <p className="text-sm font-medium text-foreground">
            Average Daily Net <span className="text-muted-foreground">· 30d</span>
          </p>
          {baselineDailyNetUsd != null ? (
            <p
              className={cn(
                "mt-2 pharos-numeric text-2xl font-extrabold leading-none sm:text-3xl",
                getNetColor(baselineDailyNetUsd),
              )}
            >
              {formatSignedCurrency(baselineDailyNetUsd)}
            </p>
          ) : (
            <UnreportedStat />
          )}
          <p className="mt-2 text-pretty text-xs leading-relaxed text-muted-foreground">
            {buildFlowSummaryNarrative(netDirection, pressureState)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-2 sm:px-5">
        <EvidenceFooter topic="mintBurnFlows" className="border-t-0 pt-0" />
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
