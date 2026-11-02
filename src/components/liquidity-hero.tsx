"use client";

import { useMemo, type ReactNode } from "react";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { UniverseChip } from "@/components/universe-chip";
import { LiquidityExitRouteMap } from "@/components/exit-route-map";
import { ExitRouteLedger } from "@/components/exit-route-ledger";
import { buildLiquidityExitRouteModel } from "@/components/exit-route-model";
import { MethodologyLabel } from "@/components/methodology-hint";
import { formatCurrency } from "@shared/lib/format";
import { describeDexVolume } from "@/lib/dex-volume-display";
import type { DexLiquidityData } from "@shared/types";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import { informativeVolumeLowerBound } from "@/components/liquidity-table-logic";

/**
 * The /liquidity/ One Beam hero, stacked: secondary exit depth with its facts,
 * the exit route map at full width, and the venue/chain ledger as its footer.
 */
export function LiquidityHero({
  stats,
  liquidityMap,
  status,
}: {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
  /** Ops state for the beam label (`OpsStatusChip`). */
  status?: ReactNode;
}) {
  const model = useMemo(() => buildLiquidityExitRouteModel(liquidityMap, stats), [liquidityMap, stats]);
  const volume = describeDexVolume(stats.totalVol, stats.totalVolAvailability);
  const volumeBound = informativeVolumeLowerBound(volume);
  const change = stats.agg7dChange;

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
              change == null || !Number.isFinite(change) ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <>
                  <span aria-hidden="true">{change >= 0 ? "↑" : "↓"}</span>
                  {Math.abs(change).toFixed(1)}%
                </>
              )
            }
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
          <HeroMetricRow
            label={<MethodologyLabel topic="liquidityScore">Liquidity Score</MethodologyLabel>}
            value={`${stats.ratedCount.toLocaleString("en-US")} rated · ${stats.nrObservedCount.toLocaleString("en-US")} NR`}
          />
        </div>
      }
      footer={model ? <ExitRouteLedger model={model} /> : undefined}
    >
      {model ? (
        <LiquidityExitRouteMap model={model} />
      ) : (
        <p className="pharos-empty-note m-5 sm:m-6 lg:m-7">
          Exit routes are unavailable for this snapshot: no published global DEX depth.
        </p>
      )}
    </FeatureHeroSplit>
  );
}
