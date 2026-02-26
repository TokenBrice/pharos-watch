"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { getCirculatingRaw, getPrevDayRaw } from "@/lib/supply";
import { formatCurrency } from "@/lib/format";
import { PSI_BAND_CLASSES } from "@/lib/psi-colors";

function KpiCell({
  label,
  value,
  sublabel,
  valueClassName,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  valueClassName?: string;
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
        <span className="text-xs text-muted-foreground">{sublabel}</span>
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

  const { totalMcap, mcapChange24hPct } = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return { totalMcap: 0, mcapChange24hPct: 0 };
    let total = 0;
    let totalPrev = 0;
    for (const coin of stablecoinsData.peggedAssets) {
      total += getCirculatingRaw(coin);
      totalPrev += getPrevDayRaw(coin);
    }
    const pct = totalPrev > 0 ? ((total - totalPrev) / totalPrev) * 100 : 0;
    return { totalMcap: total, mcapChange24hPct: pct };
  }, [stablecoinsData]);

  const isLoading = psiLoading || stablecoinsLoading || pegLoading;

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

  // PSI
  const psiCurrent = psiData?.current;
  const psiScore = psiCurrent
    ? (psiCurrent.avg24h ?? psiCurrent.score).toFixed(1)
    : "—";
  const psiBand = psiCurrent
    ? psiCurrent.avg24hBand ?? psiCurrent.band
    : "";
  const psiColorClass = PSI_BAND_CLASSES[psiBand] ?? "";

  // Peg summary
  const summary = pegData?.summary;
  const activeDepegs = summary?.activeDepegCount ?? 0;
  const coinsAtPeg = summary?.coinsAtPeg ?? 0;
  const totalTracked = summary?.totalTracked ?? 0;
  const worstBps = summary?.worstCurrent?.bps ?? null;

  // Format 24h change
  const changeSign = mcapChange24hPct >= 0 ? "+" : "";
  const changeSublabel = `${changeSign}${mcapChange24hPct.toFixed(2)}% 24h`;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border/50">
        <KpiCell
          label="PSI"
          value={psiScore}
          sublabel={psiBand}
          valueClassName={psiColorClass}
        />
        <KpiCell
          label="Total MCAP"
          value={formatCurrency(totalMcap, 1)}
          sublabel={changeSublabel}
        />
        <KpiCell
          label="Active Depegs"
          value={activeDepegs}
        />
        <KpiCell
          label="Coins at Peg"
          value={`${coinsAtPeg} / ${totalTracked}`}
        />
        <KpiCell
          label="Worst Depeg"
          value={worstBps !== null ? `${worstBps} bps` : "—"}
        />
      </div>
    </Card>
  );
}
