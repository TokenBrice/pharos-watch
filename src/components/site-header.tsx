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
  const totalPools = useMemo(
    () => dexMap ? Object.values(dexMap).reduce((sum, d) => sum + d.poolCount, 0) : undefined,
    [dexMap],
  );

  return (
    <div className="hidden lg:flex items-center gap-3">
      <Image src="/pharos-icon.png" alt="" width={32} height={32} className="rounded-lg" priority />
      <h1 className="text-xl font-mono uppercase tracking-[0.2em] font-semibold">Pharos</h1>
      <span className="text-xs text-muted-foreground/60 font-mono">
        {total} stablecoins tracking {pegCount} pegs on {chainCount} chains.
        {totalPools != null && <> {formatCount(totalPools)} pools processed,</>}
        {blacklistEvents != null && <> {formatCount(blacklistEvents)} blacklist events recorded</>}
        {(totalPools != null || blacklistEvents != null) && <>: </>}
        <span className="italic text-muted-foreground/40">Pharos sees it all</span>
      </span>
    </div>
  );
}
