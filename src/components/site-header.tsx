"use client";

import { useMemo } from "react";
import { formatCompactCount } from "@shared/lib/format";
import { useDexLiquidity, useHealth } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { TRACKED_IDS } from "@shared/lib/stablecoins";
import { PharosLogo } from "@/components/pharos-logo";

interface SiteHeaderProps {
  total: number;
  pegCount: number;
  chainCount: number;
}

const METRIC_PILL_CLASS =
  "inline-flex items-center rounded-full border px-2.5 py-1 font-mono tabular-nums text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-sm border-border/65 bg-background/78 dark:border-white/10 dark:bg-white/[0.035] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_8px_18px_rgba(0,0,0,0.18)]";

export function SiteHeader({ total, pegCount, chainCount }: SiteHeaderProps) {
  const { data: health } = useHealth();
  const { data: dexMap } = useDexLiquidity();
  const { data: stablecoinsData } = useStablecoins();

  const blacklistEvents = health?.blacklist.totalEvents;
  const mintBurnEvents = health?.mintBurn?.totalEvents;
  const totalPools = useMemo(
    () => (dexMap ? Object.values(dexMap).reduce((sum, d) => sum + d.poolCount, 0) : undefined),
    [dexMap],
  );
  const trackedStats = useMemo(() => {
    const stats: string[] = [];
    if (totalPools != null) {
      stats.push(`${formatCompactCount(totalPools)} pools processed`);
    }

    if (mintBurnEvents != null) {
      stats.push(`${formatCompactCount(mintBurnEvents)} mint/burn events recorded`);
    }
    if (blacklistEvents != null) {
      stats.push(`${formatCompactCount(blacklistEvents)} blacklist events recorded`);
    }

    return stats;
  }, [totalPools, blacklistEvents, mintBurnEvents]);

  const liveTrackedCount = useMemo(() => {
    const assets = stablecoinsData?.peggedAssets;
    if (!assets) return total;

    const availableIds = new Set(assets.map((asset) => asset.id));
    let count = 0;
    for (const id of TRACKED_IDS) {
      if (availableIds.has(id)) count++;
    }
    return count;
  }, [stablecoinsData, total]);

  return (
    <div className="pharos-card-shell hidden lg:flex items-end justify-between gap-6 px-5 py-5">
      <div className="flex min-w-0 items-center gap-4">
        <PharosLogo size={40} className="rounded-xl shadow-sm" priority />
        <div className="min-w-0 space-y-1.5">
          <p className="text-[1.06rem] font-mono font-semibold uppercase tracking-[0.16em] text-foreground">Pharos</p>
          <p className="max-w-2xl text-sm leading-relaxed tracking-[0.01em] text-muted-foreground/88">
            Live market intelligence for stablecoins: peg stress, liquidity analysis, blacklist tracking, risk-adjusted-yield and hidden dependencies
            in one research surface.
          </p>
        </div>
      </div>

      <div className="grid gap-2 text-[11px]">
        <div className="flex flex-wrap justify-end gap-2">
          <span className={METRIC_PILL_CLASS}>{formatCompactCount(liveTrackedCount)} coins</span>
          <span className={METRIC_PILL_CLASS}>{formatCompactCount(pegCount)} pegs</span>
          <span className={METRIC_PILL_CLASS}>{formatCompactCount(chainCount)} chains</span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {trackedStats.map((stat) => (
            <span key={stat} className={METRIC_PILL_CLASS}>
              {stat}
            </span>
          ))}
        </div>
        <p className="text-right text-[11px] leading-relaxed text-muted-foreground/80">
          Watch live conditions first, then move deeper into dossier pages, comparisons, and route-specific risk surfaces.
        </p>
      </div>
    </div>
  );
}
