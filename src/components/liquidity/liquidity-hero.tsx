"use client";

import { useMemo, type ReactNode } from "react";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { UniverseChip } from "@/components/universe-chip";
import { LiquidityExitRouteMap } from "@/components/liquidity/exit-route-map";
import { ExitRouteLedger } from "@/components/liquidity/exit-route-ledger";
import { buildLiquidityExitRouteModel } from "@/components/liquidity/exit-route-model";
import { MethodologyLabel } from "@/components/methodology-hint";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { describeDexVolume } from "@/lib/dex-volume-display";
import type { DexLiquidityData } from "@shared/types/dex-liquidity";
import type { LiquidityStatsData } from "@/components/liquidity/liquidity-stats-types";
import type { LiquidityRouteFilter } from "@/app/liquidity/model";
import { informativeVolumeLowerBound } from "@/components/liquidity/liquidity-table-logic";

/**
 * The /liquidity/ One Beam hero, stacked: secondary exit depth with its facts,
 * the exit route map at full width, and the venue/chain ledger as its footer.
 */
export function LiquidityHero({
  stats,
  liquidityMap,
  status,
  activeRouteFilter = null,
  onRouteFilterChange,
}: {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
  /** Ops state for the beam label (`OpsStatusChip`). */
  status?: ReactNode;
  activeRouteFilter?: LiquidityRouteFilter | null;
  onRouteFilterChange?: (filter: LiquidityRouteFilter | null) => void;
}) {
  const model = useMemo(() => buildLiquidityExitRouteModel(liquidityMap, stats), [liquidityMap, stats]);
  const volume = describeDexVolume(stats.totalVol, stats.totalVolAvailability);
  const volumeBound = informativeVolumeLowerBound(volume);
  const change = stats.agg7dChange;
  const useMedianFallback = change === null && stats.median7dChange != null && Number.isFinite(stats.median7dChange);
  const displayChange = change != null && Number.isFinite(change)
    ? change
    : useMedianFallback
      ? stats.median7dChange!
      : null;
  const changeDetail = useMedianFallback
    ? `median across ${(stats.change7dCoinCount ?? 0).toLocaleString("en-US")} coins`
    : change != null && Number.isFinite(change) && stats.agg7dChangeBasis === "global"
      ? "global deduped TVL"
      : change === null && (stats.change7dCoinCount ?? 0) === 0
        ? undefined
        : undefined;
  const depthRatio = stats.aggDepthToMcapRatio;
  const depthRatioDetail =
    depthRatio != null &&
    stats.aggDepthToMcapObservedCount != null &&
    stats.aggDepthToMcapObservedCount < stats.withLiquidity
      ? `${stats.aggDepthToMcapObservedCount.toLocaleString("en-US")} of ${stats.withLiquidity.toLocaleString("en-US")} with supply`
      : "DEX TVL / circulating supply";

  return (
    <FeatureHeroSplit
      layout="stacked"
      ariaLabel="Secondary exit depth"
      beamLabel="Secondary exit depth"
      beamValue={stats.totalTvl == null ? "—" : formatCurrency(stats.totalTvl)}
      status={status}
      universe={
        <UniverseChip
          universe="active"
          value={`${stats.withLiquidity.toLocaleString("en-US")} of ${stats.totalTracked.toLocaleString("en-US")} observed on DEX`}
        />
      }
      sub={
        <div className="divide-y divide-border/50">
          <HeroMetricRow
            label="7d change, coins with 7d history"
            value={
              displayChange == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <>
                  <span aria-hidden="true">{displayChange >= 0 ? "↑" : "↓"}</span>
                  {Math.abs(displayChange).toFixed(1)}%
                </>
              )
            }
            detail={changeDetail}
          />
          {/* A partial window headlines its admitted sum as an explicit lower bound, never a total (R1/R7). */}
          <HeroMetricRow
            label="24h DEX volume"
            value={
              volumeBound ? (
                <span title={volume.title}>{volumeBound}</span>
              ) : volume.view.valueUsd != null ? (
                volume.text
              ) : (
                <span className="text-muted-foreground" title={volume.title}>{volume.text}</span>
              )
            }
            detail={
              volumeBound ? volume.lowerBound?.detail
                : volume.view.partialGrossUsd == null ? (volume.detail ?? undefined) : undefined
            }
          />
          {depthRatio != null && Number.isFinite(depthRatio) ? (
            <HeroMetricRow
              label="Depth / MCap"
              value={depthRatio > 0 && depthRatio < 0.0005 ? "<0.1%" : formatPercent(depthRatio * 100, 1)}
              detail={depthRatioDetail}
            />
          ) : null}
          <HeroMetricRow
            label={<MethodologyLabel topic="liquidityScore">Liquidity Score</MethodologyLabel>}
            value={`${stats.ratedCount.toLocaleString("en-US")} rated · ${stats.nrObservedCount.toLocaleString("en-US")} NR`}
          />
        </div>
      }
      footer={
        model ? (
          <ExitRouteLedger
            model={model}
            activeRouteFilter={activeRouteFilter}
            onRouteFilterChange={onRouteFilterChange}
          />
        ) : undefined
      }
    >
      {model ? (
        <LiquidityExitRouteMap
          model={model}
          activeRouteFilter={activeRouteFilter}
          onRouteFilterChange={onRouteFilterChange}
        />
      ) : (
        <p className="pharos-empty-note m-5 sm:m-6 lg:m-7">
          Exit routes are unavailable for this snapshot: no published global DEX depth.
        </p>
      )}
    </FeatureHeroSplit>
  );
}
