"use client";

import { useMemo } from "react";
import { formatCompactCount } from "@shared/lib/format";
import { useDexLiquidity, useHealth } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { PharosLogo } from "@/components/pharos-logo";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

interface SiteHeaderProps {
  total: number;
  pegCount: number;
  chainCount: number;
}

const METRIC_PILL_CLASS =
  "inline-flex items-center rounded-full border px-2 py-0.5 font-mono tabular-nums text-muted-foreground sm:px-2.5 sm:py-1" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";

interface MetricPill {
  value: string;
  label: string;
}

function MetricPills({ metrics }: { metrics: MetricPill[] }) {
  return (
    <>
      {metrics.map((metric) => (
        <span key={metric.label} className={METRIC_PILL_CLASS}>
          <span className="text-foreground">{metric.value}</span>
          <span className="ml-1 text-muted-foreground/70">{metric.label}</span>
        </span>
      ))}
    </>
  );
}

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

    return assets.filter((asset) => TRACKED_META_BY_ID.has(asset.id)).length;
  }, [stablecoinsData, total]);
  const headlineMetrics = useMemo(
    () => [
      { value: formatCompactCount(liveTrackedCount), label: "coins" },
      { value: formatCompactCount(pegCount), label: "pegs" },
      { value: formatCompactCount(chainCount), label: "chains" },
    ],
    [chainCount, liveTrackedCount, pegCount],
  );

  return (
    <div className="pharos-card-shell flex flex-col gap-2 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-2.5 md:flex-row md:items-center md:justify-between md:gap-6 md:px-5 md:py-3">
      <div className="flex min-w-0 items-center gap-2.5 md:gap-3.5">
        <span className="md:hidden">
          <PharosLogo size={26} className="shrink-0 rounded-lg shadow-sm" priority />
        </span>
        <span className="hidden md:block">
          <PharosLogo size={32} className="rounded-lg shadow-sm" priority />
        </span>
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-sm font-mono font-semibold uppercase tracking-[0.14em] text-foreground md:text-[1.02rem] md:tracking-[0.16em]">
            Pharos Watch
          </h1>
          <p className="hidden truncate text-xs leading-snug tracking-[0.01em] text-muted-foreground/85 md:block md:text-[13px]">
            Live depeg, freeze, safety, and liquidity signals across every tracked stablecoin.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5 text-[11px] md:hidden">
          <MetricPills metrics={headlineMetrics} />
        </div>
      </div>

      <div className="hidden flex-wrap items-center justify-end gap-2 text-[11px] md:flex">
        <MetricPills metrics={headlineMetrics} />
        {trackedStats.map((stat) => (
          <span key={stat} className={`${METRIC_PILL_CLASS} hidden xl:inline-flex`}>
            {stat}
          </span>
        ))}
      </div>
    </div>
  );
}
