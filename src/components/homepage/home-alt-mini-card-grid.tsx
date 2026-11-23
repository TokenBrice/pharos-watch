"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { HomeSectionErrorBoundary } from "@/components/homepage/home-section-error-boundary";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";
import {
  SupplyMovesCard,
  computeSupplyMovers,
  formatSupplyMovePct,
  selectPeakSupplyMover,
} from "@/components/home-alt-mini-cards/supply-moves-card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary, useStabilityIndex } from "@/hooks/api-hooks";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { bucketByDeviationBps } from "@/lib/home-alt-aggregates";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { aggregateCoinFlows24h, inferHas24hActivity } from "@shared/lib/mint-burn-coin-helpers";
import { buildBlacklistStatusBuckets } from "@shared/lib/blacklist-status-buckets";
import { computeFreezableSummary, formatShare } from "@shared/lib/freezewatch/freezable-summary";
import { selectActiveDepegCoins } from "@shared/lib/active-depegs";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { readPublishedDeviation } from "@/lib/current-peg";
import { formatScore, formatSignedCompactUsd } from "@shared/lib/format";
import {
  type ConditionBand,
  DEPEG_DIRECTION_CLASSES,
  DIRECTION_TONE_CLASSES,
  PEG_DEVIATION_TONE_CLASSES,
  PSI_BAND_CLASSES,
} from "@shared/lib/classification";

function MobilePulseTile({
  href,
  label,
  isLoading,
  unavailable,
  value,
  subline,
  extra,
}: {
  href: string;
  label: React.ReactNode;
  isLoading: boolean;
  unavailable: boolean;
  value: React.ReactNode;
  subline: React.ReactNode;
  extra?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      prefetch={false}
      href={href}
      className="pharos-card-shell pharos-focus-ring flex min-h-[104px] flex-col justify-between gap-1.5 p-3 transition-colors hover:border-border"
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      </div>
      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : unavailable ? (
        <div>
          <span className="pharos-numeric block text-2xl font-bold leading-none text-muted-foreground/50">—</span>
          <span className="pharos-meta mt-1 block">Updating</span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="pharos-numeric text-2xl font-bold leading-none tracking-tight text-foreground">{value}</div>
          <div className="truncate text-2xs text-muted-foreground">{subline}</div>
          {extra}
        </div>
      )}
    </Link>
  );
}

/**
 * Dense mobile (< md) 2x3 Pulse KPI tile grid (Q7): cuts mobile pre-table
 * scroll height while sharing every desktop query cache with zero extra
 * network calls.
 */
function MobilePulseKpiGrid(): React.JSX.Element {
  const pegQuery = usePegSummary();
  const psiQuery = useStabilityIndex();
  const flowsQuery = useMintBurnFlows();
  const stablecoinsQuery = useStablecoins();
  const blacklistSummaryQuery = useBlacklistSummary();

  const pegSummary = pegQuery.data?.summary;
  const activeCount = pegSummary?.activeDepegCount ?? null;
  const leadDepeg = useMemo(() => {
    const coins = selectActiveDepegCoins(pegQuery.data?.coins ?? [], ACTIVE_STABLECOIN_ID_SET);
    let worst: { symbol: string; bps: number } | null = null;
    for (const coin of coins) {
      const { deviationBps } = readPublishedDeviation(coin.pegCurrency, coin);
      if (deviationBps == null) continue;
      if (!worst || Math.abs(deviationBps) > Math.abs(worst.bps)) {
        worst = { symbol: coin.symbol ?? coin.id, bps: deviationBps };
      }
    }
    return worst;
  }, [pegQuery.data?.coins]);

  const pegBuckets = useMemo(() => bucketByDeviationBps(pegQuery.data?.coins ?? []), [pegQuery.data?.coins]);
  const pegBucketTotal = pegBuckets.healthy + pegBuckets.mild + pegBuckets.moderate + pegBuckets.severe;

  const psiCurrent = psiQuery.data?.current ?? null;
  const displayedPsi = psiCurrent ? getDisplayedPsi(psiCurrent) : null;
  const beacon = usePsiBeaconState({
    current: psiCurrent,
    meta: psiQuery.meta,
    dataUpdatedAt: psiQuery.dataUpdatedAt,
    error: psiQuery.error,
    isLoading: psiQuery.isLoading,
  });
  const psiBand = displayedPsi?.band as ConditionBand | undefined;
  const psiBandLabel = psiBand ? psiBand.charAt(0) + psiBand.slice(1).toLowerCase() : null;
  const psiBandClass = psiBand && beacon.isCurrent ? (PSI_BAND_CLASSES[psiBand] ?? "text-foreground") : "text-muted-foreground";

  const { flowNetUsd, hasFlowActivity } = useMemo(() => {
    const activeCoins = (flowsQuery.data?.coins ?? []).filter((coin) => inferHas24hActivity(coin) !== false);
    const totalNet = aggregateCoinFlows24h(flowsQuery.data?.coins ?? []).net;
    return {
      flowNetUsd: totalNet.valueUsd ?? totalNet.subtotal?.valueUsd ?? null,
      hasFlowActivity: activeCoins.length > 0,
    };
  }, [flowsQuery.data?.coins]);
  const flowBand = flowsQuery.data?.gauge?.band;
  const flowBandLabel = flowBand ? flowBand.charAt(0) + flowBand.slice(1).toLowerCase() : "—";

  const { supplyMovePeak, supplyMoveUpCount, supplyMoveDownCount, supplyMovesEvaluated } = useMemo(() => {
    const payloadObservedAtSec = stablecoinsQuery.meta?.updatedAt ?? Math.floor((stablecoinsQuery.dataUpdatedAt ?? 0) / 1000);
    const { ups, downs, upCount, downCount, evaluated } = computeSupplyMovers(
      stablecoinsQuery.data?.peggedAssets ?? [],
      payloadObservedAtSec,
    );
    return {
      supplyMovePeak: selectPeakSupplyMover(ups, downs),
      supplyMoveUpCount: upCount,
      supplyMoveDownCount: downCount,
      supplyMovesEvaluated: evaluated,
    };
  }, [stablecoinsQuery.data, stablecoinsQuery.meta?.updatedAt, stablecoinsQuery.dataUpdatedAt]);

  const freezable = useMemo(
    () => computeFreezableSummary(stablecoinsQuery.data ? buildBlacklistStatusBuckets(stablecoinsQuery.data.peggedAssets) : null),
    [stablecoinsQuery.data],
  );
  const freezeCount24h = blacklistSummaryQuery.data?.stats.recentFreezeCount24h ?? null;
  const freezableShareAvailable = freezable.freezableShare != null && freezable.coverage !== "unavailable";

  return (
    <div className="grid grid-cols-2 gap-2.5 md:hidden" data-testid="mobile-pulse-kpi-grid">
      <MobilePulseTile
        href="/depeg/"
        label="Active depegs"
        isLoading={pegQuery.isLoading && !pegQuery.data}
        unavailable={!pegQuery.data || activeCount === null}
        value={activeCount ?? "—"}
        subline={
          activeCount === 0 ? (
            <span className={DIRECTION_TONE_CLASSES.up}>No open incidents</span>
          ) : leadDepeg ? (
            <span>
              {leadDepeg.symbol}{" "}
              <span className={leadDepeg.bps < 0 ? DEPEG_DIRECTION_CLASSES.below.text : DEPEG_DIRECTION_CLASSES.above.text}>
                {leadDepeg.bps < 0 ? "↓" : "↑"}{Math.abs(leadDepeg.bps).toFixed(0)} bps
              </span>
            </span>
          ) : (
            "Confirmed incidents"
          )
        }
      />

      <MobilePulseTile
        href="/depeg/"
        label="Peg health"
        isLoading={pegQuery.isLoading && !pegSummary}
        unavailable={!pegSummary}
        value={
          pegSummary ? (
            <>
              {pegSummary.coinsAtPeg}
              <span className="mx-0.5 text-base font-normal text-muted-foreground/60">/</span>
              <span className="text-lg font-semibold text-muted-foreground">{pegSummary.totalTracked}</span>
            </>
          ) : "—"
        }
        subline={
          pegSummary?.medianDeviationBps != null
            ? `${pegSummary.medianDeviationBps.toFixed(0)} bps median`
            : "Priced non-NAV"
        }
        extra={
          pegBucketTotal > 0 ? (
            <div className="mt-1 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60" aria-hidden="true">
              {(["healthy", "mild", "moderate", "severe"] as const).map((level) => {
                const count = pegBuckets[level];
                if (count === 0) return null;
                return (
                  <span
                    key={level}
                    className={PEG_DEVIATION_TONE_CLASSES[level].bar}
                    style={{ width: `${(count / pegBucketTotal) * 100}%` }}
                  />
                );
              })}
            </div>
          ) : null
        }
      />

      <MobilePulseTile
        href="/stability-index/"
        label="Stability Index"
        isLoading={psiQuery.isLoading && !displayedPsi}
        unavailable={!displayedPsi}
        value={displayedPsi ? formatScore(displayedPsi.score) : "—"}
        subline={
          psiBandLabel ? (
            <span className={`font-medium ${psiBandClass}`}>{psiBandLabel}</span>
          ) : "PSI regime"
        }
      />

      <MobilePulseTile
        href="/flows/"
        label="Mint / Burn"
        isLoading={flowsQuery.isLoading && !flowsQuery.data}
        unavailable={!flowsQuery.data}
        value={flowBandLabel}
        subline={
          !hasFlowActivity
            ? "No 24h activity"
            : flowNetUsd != null
              ? `Net ${formatSignedCompactUsd(flowNetUsd)}`
              : "24h flows"
        }
      />

      <MobilePulseTile
        href="/flows/"
        label="Biggest move (7d)"
        isLoading={stablecoinsQuery.isLoading && !stablecoinsQuery.data}
        unavailable={!stablecoinsQuery.data || !supplyMovesEvaluated}
        value={
          supplyMovePeak ? (
            <span className={supplyMovePeak.pctChange >= 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down}>
              {formatSupplyMovePct(supplyMovePeak.pctChange)}
            </span>
          ) : (
            "0%"
          )
        }
        subline={
          supplyMovePeak ? (
            <span>
              {supplyMovePeak.symbol}
              {" · "}
              {supplyMoveUpCount}↑ {supplyMoveDownCount}↓
            </span>
          ) : (
            "No 7d moves"
          )
        }
      />

      <MobilePulseTile
        href="/freezewatch/"
        label="Freezable supply"
        isLoading={stablecoinsQuery.isLoading && !stablecoinsQuery.data}
        unavailable={!stablecoinsQuery.data || !freezableShareAvailable}
        value={freezableShareAvailable ? formatShare(freezable.freezableShare!) : "—"}
        subline={
          freezeCount24h != null
            ? `${freezeCount24h.toLocaleString("en-US")} ${freezeCount24h === 1 ? "freeze" : "freezes"} 24h`
            : freezable.coverage === "partial"
              ? "Observed supply"
              : "Tracked supply"
        }
      />
    </div>
  );
}

// Locked Market Pulse bento (Q6, Q7):
// - Desktop/tablet (md+): Row 1 permanently leads with Active depegs, Peg health,
//   and the stacked PSI + Mint/Burn pair (no Row-2 swap, no clipped Digest slot).
//   Row 2 holds Supply moves and FreezeWatch side by side.
// - Mobile (< md): dense 2x3 Pulse KPI tile grid.
export function HomeAltMiniCardGrid(): React.JSX.Element {
  return (
    <HomeSectionErrorBoundary name="mini-card grid">
      <MobilePulseKpiGrid />
      <div className="@container hidden space-y-3 md:block" data-testid="desktop-pulse-bento">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[minmax(322px,auto)] @4xl:grid-cols-3">
          <ActiveDepegsCard />
          <PegHealthCard />
          <div className="pharos-card-shell grid h-full grid-rows-[1fr_1fr] overflow-hidden">
            <div className="min-h-0 border-b border-border/50">
              <PsiBandCard embedded />
            </div>
            <div className="min-h-0">
              <MintBurnCard embedded />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <SupplyMovesCard />
          <RecentFreezesCard />
        </div>
      </div>
    </HomeSectionErrorBoundary>
  );
}
