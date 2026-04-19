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
  "inline-flex items-center rounded-full border px-2.5 py-1 font-mono tabular-nums text-muted-foreground" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";

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

    if (mintBurnEvents != null && mintBurnEvents > 0) {
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
    <div className="pharos-card-shell flex flex-col gap-3 px-4 py-3 md:flex-row md:items-end md:justify-between md:gap-6 md:px-5 md:py-5">
      <div className="flex min-w-0 items-center gap-3 md:gap-4">
        <span className="md:hidden">
          <PharosLogo size={28} className="shrink-0 rounded-lg shadow-sm" priority />
        </span>
        <span className="hidden md:block">
          <PharosLogo size={40} className="rounded-xl shadow-sm" priority />
        </span>
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-sm font-mono font-semibold uppercase tracking-[0.14em] text-foreground md:text-[1.06rem] md:tracking-[0.16em]">
            Pharos
          </h1>
          <p className="hidden max-w-2xl text-sm leading-relaxed tracking-[0.01em] text-muted-foreground/88 md:line-clamp-2 md:block lg:line-clamp-none">
            Chart your route through the stablecoin market — live peg, safety, liquidity, and dependency signals on every tracked coin.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5 text-[11px] md:hidden">
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(liveTrackedCount)}</span>
            <span className="ml-1 text-muted-foreground/70">coins</span>
          </span>
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(pegCount)}</span>
            <span className="ml-1 text-muted-foreground/70">pegs</span>
          </span>
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(chainCount)}</span>
            <span className="ml-1 text-muted-foreground/70">chains</span>
          </span>
        </div>
      </div>

      <div className="hidden gap-2 text-[11px] md:grid">
        <div className="flex flex-wrap justify-end gap-2">
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(liveTrackedCount)}</span>
            <span className="ml-1 text-muted-foreground/70">coins</span>
          </span>
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(pegCount)}</span>
            <span className="ml-1 text-muted-foreground/70">pegs</span>
          </span>
          <span className={METRIC_PILL_CLASS}>
            <span className="text-foreground">{formatCompactCount(chainCount)}</span>
            <span className="ml-1 text-muted-foreground/70">chains</span>
          </span>
        </div>
        <div className="hidden flex-wrap justify-end gap-2 2xl:flex">
          {trackedStats.map((stat) => (
            <span key={stat} className={METRIC_PILL_CLASS}>
              {stat}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
