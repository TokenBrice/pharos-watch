"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useHealth } from "@/hooks/use-health";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { TRACKED_IDS } from "@shared/lib/stablecoins";

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

interface SiteHeaderProps {
  total: number;
  pegCount: number;
  chainCount: number;
}

export function SiteHeader({ total, pegCount, chainCount }: SiteHeaderProps) {
  const { data: health } = useHealth();
  const { data: dexMap } = useDexLiquidity();
  const { data: stablecoinsData } = useStablecoins();

  const blacklistEvents = health?.blacklist.totalEvents;
  const mintBurnEvents = health?.mintBurn?.totalEvents;
  const totalPools = useMemo(
    () => dexMap ? Object.values(dexMap).reduce((sum, d) => sum + d.poolCount, 0) : undefined,
    [dexMap],
  );
  const trackedStats = useMemo(
    () => {
      const stats: string[] = [];
      if (totalPools != null) {
        stats.push(`${formatCount(totalPools)} pools processed`);
      }

      if (mintBurnEvents != null) {
        stats.push(`${formatCount(mintBurnEvents)} mint/burn events recorded`);
      }
      if (blacklistEvents != null) {
        stats.push(`${formatCount(blacklistEvents)} blacklist events recorded`);
      }

      return stats;
    },
    [totalPools, blacklistEvents, mintBurnEvents],
  );

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
    <div className="pharos-card-shell hidden lg:flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <Image
          src="/pharos-icon.png"
          alt=""
          width={32}
          height={32}
          className="rounded-lg ring-1 ring-border/60 bg-slate-900/90 shadow-sm dark:bg-transparent"
          priority
        />
        <div className="min-w-0">
          <h1 className="text-[1.02rem] font-mono font-semibold uppercase tracking-[0.16em] text-foreground">
            Pharos
          </h1>
          <p className="mt-0.5 text-xs tracking-[0.01em] text-muted-foreground/85">
            Stablecoin intelligence: watching every peg.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 text-[11px]">
        <span className="inline-flex items-center rounded-full border border-border/65 bg-background/72 px-2.5 py-1 font-mono tabular-nums text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.25)]">
          {formatCount(liveTrackedCount)} coins
        </span>
        <span className="inline-flex items-center rounded-full border border-border/65 bg-background/72 px-2.5 py-1 font-mono tabular-nums text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.25)]">
          {formatCount(pegCount)} pegs
        </span>
        <span className="inline-flex items-center rounded-full border border-border/65 bg-background/72 px-2.5 py-1 font-mono tabular-nums text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.25)]">
          {formatCount(chainCount)} chains
        </span>
        {trackedStats.map((stat) => (
          <span
            key={stat}
            className="inline-flex items-center rounded-full border border-border/65 bg-background/72 px-2.5 py-1 font-mono text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.25)]"
          >
            {stat}
          </span>
        ))}
      </div>
    </div>
  );
}
