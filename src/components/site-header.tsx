"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useHealth } from "@/hooks/use-health";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";

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

  return (
    <div className="hidden lg:flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-card/70 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Image
          src="/pharos-icon.png"
          alt=""
          width={32}
          height={32}
          className="rounded-lg ring-1 ring-border/60"
          priority
        />
        <div className="min-w-0">
          <h1 className="text-base font-mono font-semibold uppercase tracking-[0.18em] text-foreground">
            Pharos
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground/80">
            Stablecoin intelligence: watching every peg.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 text-[11px]">
        <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono tabular-nums text-muted-foreground">
          {formatCount(total)} coins
        </span>
        <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono tabular-nums text-muted-foreground">
          {formatCount(pegCount)} pegs
        </span>
        <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono tabular-nums text-muted-foreground">
          {formatCount(chainCount)} chains
        </span>
        {trackedStats.map((stat) => (
          <span
            key={stat}
            className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono text-muted-foreground"
          >
            {stat}
          </span>
        ))}
      </div>
    </div>
  );
}
