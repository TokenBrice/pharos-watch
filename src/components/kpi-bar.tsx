"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@/lib/supply";
import { formatCurrency } from "@/lib/format";
import { PSI_BAND_CLASSES } from "@/lib/psi-colors";

/** Green for positive, red for negative, muted for zero. */
function deltaColor(value: number): string {
  if (value > 0) return "text-green-500";
  if (value < 0) return "text-red-500";
  return "text-muted-foreground";
}

function KpiCell({
  label,
  value,
  sublabel,
  valueClassName,
  sublabelClassName,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  valueClassName?: string;
  sublabelClassName?: string;
}) {
  return (
    <div className="px-4 py-3 flex flex-col gap-0.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={`text-xl font-extrabold font-mono tabular-nums ${valueClassName ?? ""}`}>
        {value}
      </span>
      {sublabel && (
        <span className={`text-xs ${sublabelClassName ?? "text-muted-foreground"}`}>{sublabel}</span>
      )}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="px-4 py-3 flex flex-col gap-0.5">
      <Skeleton className="h-3.5 w-16" />
      <Skeleton className="h-7 w-20" />
    </div>
  );
}

export function KpiBar() {
  const { data: psiData, isLoading: psiLoading } = useStabilityIndex();
  const { data: stablecoinsData, isLoading: stablecoinsLoading } = useStablecoins();
  const { data: pegData, isLoading: pegLoading } = usePegSummary();
  const { data: dexData, isLoading: dexLoading } = useDexLiquidity();

  const { totalMcap, mcapChange24hPct, mcapChange7dPct } = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return { totalMcap: 0, mcapChange24hPct: 0, mcapChange7dPct: 0 };
    let total = 0;
    let totalPrev = 0;
    let totalPrevWeek = 0;
    for (const coin of stablecoinsData.peggedAssets) {
      total += getCirculatingRaw(coin);
      totalPrev += getPrevDayRaw(coin);
      totalPrevWeek += getPrevWeekRaw(coin);
    }
    const pct24h = totalPrev > 0 ? ((total - totalPrev) / totalPrev) * 100 : 0;
    const pct7d = totalPrevWeek > 0 ? ((total - totalPrevWeek) / totalPrevWeek) * 100 : 0;
    return { totalMcap: total, mcapChange24hPct: pct24h, mcapChange7dPct: pct7d };
  }, [stablecoinsData]);

  const { totalVol24h, volVs7dAvgPct } = useMemo(() => {
    if (!dexData) return { totalVol24h: 0, volVs7dAvgPct: 0 };
    let vol24h = 0;
    let vol7d = 0;
    for (const liq of Object.values(dexData)) {
      vol24h += liq.totalVolume24hUsd;
      vol7d += liq.totalVolume7dUsd;
    }
    const avg7d = vol7d / 7;
    const pct = avg7d > 0 ? ((vol24h - avg7d) / avg7d) * 100 : 0;
    return { totalVol24h: vol24h, volVs7dAvgPct: pct };
  }, [dexData]);

  // PSI derived values (must be before early return to satisfy hook rules)
  const psiCurrent = psiData?.current;
  const psiScore = psiCurrent
    ? (psiCurrent.avg24h ?? psiCurrent.score).toFixed(1)
    : "—";
  const psiBand = psiCurrent
    ? psiCurrent.avg24hBand ?? psiCurrent.band
    : "";
  const psiColorClass = PSI_BAND_CLASSES[psiBand] ?? "";

  const { psiDaysInBand, psiDelta1d, psiDelta7d } = useMemo(() => {
    if (!psiBand || !psiData?.history) return { psiDaysInBand: 0, psiDelta1d: null, psiDelta7d: null };
    let days = 1; // today counts
    for (const point of psiData.history) {
      if (point.band === psiBand) days++;
      else break;
    }
    const currentScore = psiCurrent!.avg24h ?? psiCurrent!.score;
    const d1 = psiData.history.length >= 1 ? currentScore - psiData.history[0].score : null;
    const last7 = psiData.history.slice(0, 7);
    const d7 = last7.length >= 7
      ? currentScore - last7.reduce((s, p) => s + p.score, 0) / last7.length
      : null;
    return { psiDaysInBand: days, psiDelta1d: d1, psiDelta7d: d7 };
  }, [psiData, psiBand, psiCurrent]);

  const psiSublabel = (() => {
    if (!psiBand) return "";
    const parts: string[] = [];
    if (psiDelta1d !== null) {
      const sign = psiDelta1d >= 0 ? "+" : "";
      parts.push(`${sign}${psiDelta1d.toFixed(1)} vs 1d`);
    }
    if (psiDelta7d !== null) {
      const sign = psiDelta7d >= 0 ? "+" : "";
      parts.push(`${sign}${psiDelta7d.toFixed(1)} vs 7d`);
    }
    parts.push(`${psiBand} ${psiDaysInBand}d`);
    return parts.join(" · ");
  })();

  const isLoading = psiLoading || stablecoinsLoading || pegLoading || dexLoading;

  if (isLoading) {
    return (
      <Card className="p-0 overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border/50">
          <KpiSkeleton />
          <KpiSkeleton />
          <KpiSkeleton />
          <KpiSkeleton />
          <KpiSkeleton />
        </div>
      </Card>
    );
  }

  // Peg summary
  const summary = pegData?.summary;
  const coinsAtPeg = summary?.coinsAtPeg ?? 0;
  const totalTracked = summary?.totalTracked ?? 0;
  const depegToday = summary?.depegEventsToday ?? 0;
  const depegYesterday = summary?.depegEventsYesterday ?? 0;
  const depegDelta = depegToday - depegYesterday;

  // Format 24h + 7d change
  const sign24h = mcapChange24hPct >= 0 ? "+" : "";
  const sign7d = mcapChange7dPct >= 0 ? "+" : "";
  const changeSublabel = `${sign24h}${mcapChange24hPct.toFixed(2)}% 24h · ${sign7d}${mcapChange7dPct.toFixed(2)}% 7d`;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border/50">
        <KpiCell
          label="Pharos Stability Index"
          value={psiScore}
          sublabel={psiSublabel}
          valueClassName={psiColorClass}
          sublabelClassName={psiDelta1d !== null ? deltaColor(psiDelta1d) : undefined}
        />
        <KpiCell
          label="Total Stablecoin Mcap"
          value={formatCurrency(totalMcap, 1)}
          sublabel={changeSublabel}
          sublabelClassName={deltaColor(mcapChange24hPct)}
        />
        <KpiCell
          label="Tracked 24H DEX Vol"
          value={formatCurrency(totalVol24h, 1)}
          sublabel={`${volVs7dAvgPct >= 0 ? "+" : ""}${volVs7dAvgPct.toFixed(1)}% vs 7d avg`}
          sublabelClassName={deltaColor(volVs7dAvgPct)}
        />
        <KpiCell
          label="Stablecoins at Peg"
          value={`${coinsAtPeg} / ${totalTracked}`}
        />
        <KpiCell
          label="Depeg Events Today"
          value={depegToday}
          sublabel={`${depegDelta >= 0 ? "+" : ""}${depegDelta} vs yesterday`}
          sublabelClassName={deltaColor(-depegDelta)}
        />
      </div>
    </Card>
  );
}
