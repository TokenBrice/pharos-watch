"use client";

import { useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@/lib/supply";
import { formatCurrency } from "@/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@/lib/psi-colors";
import { THREAT_BAND_COLORS, type ThreatBand } from "@/lib/classification";

type TrendDirection = "up" | "down" | "flat";
type ElevatedThreatBand = Extract<ThreatBand, "DANGER" | "ALERT" | "WARNING">;
const KPI_CHIP_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]";

function trendDirection(value: number): TrendDirection {
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function trendTextClass(value: number): string {
  if (value > 0) return "text-green-500";
  if (value < 0) return "text-red-500";
  return "text-muted-foreground";
}

function TrendChip({
  label,
  value,
  direction,
}: {
  label: string;
  value: string;
  direction: TrendDirection;
}) {
  const toneClasses = direction === "up"
    ? "border-green-500/25 bg-green-500/10 text-green-500"
    : direction === "down"
      ? "border-red-500/25 bg-red-500/10 text-red-500"
      : "border-border bg-muted/40 text-muted-foreground";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  return (
    <span className={`${KPI_CHIP_BASE} font-medium ${toneClasses}`}>
      <Icon className="size-3" aria-hidden />
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

function InfoChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "positive" | "negative" | "warning";
}) {
  const toneClasses = tone === "positive"
    ? "border-green-500/25 bg-green-500/10 text-green-500"
    : tone === "negative"
      ? "border-red-500/25 bg-red-500/10 text-red-500"
    : tone === "warning"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-500"
        : "border-border bg-muted/40 text-muted-foreground";

  return (
    <span className={`${KPI_CHIP_BASE} ${toneClasses}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

function DewsBandChip({ band, count }: { band: ElevatedThreatBand; count: number }) {
  const label = band === "DANGER" ? "CRITICAL" : band;
  return (
    <span className={`${KPI_CHIP_BASE} font-semibold ${THREAT_BAND_COLORS[band]}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
    </span>
  );
}

function KpiCell({
  label,
  value,
  sublabel,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-h-[108px] flex-col gap-1.5 px-4 py-3">
      <span className="pharos-kicker">
        {label}
      </span>
      <span className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
        {value}
      </span>
      {sublabel && (
        <div className="mt-auto flex flex-wrap items-center gap-1 text-xs">{sublabel}</div>
      )}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="flex min-h-[108px] flex-col gap-1.5 px-4 py-3">
      <Skeleton className="h-3.5 w-20" />
      <Skeleton className="h-7 w-24" />
      <div className="mt-auto flex items-center gap-1.5">
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
    </div>
  );
}

function KpiMiniTile({
  label,
  value,
  metaPrimary,
  metaSecondary,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  metaPrimary?: React.ReactNode;
  metaSecondary?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="pharos-card-shell min-h-[100px] px-3 py-2.5">
      <p className="pharos-kicker tracking-[0.08em]">{label}</p>
      <p className={`mt-1 text-lg font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>{value}</p>
      {metaPrimary && (
        <div className="mt-1 text-[11px] font-mono leading-snug">{metaPrimary}</div>
      )}
      {metaSecondary && (
        <div className="mt-0.5 text-[11px] font-mono leading-snug">{metaSecondary}</div>
      )}
    </div>
  );
}

export function KpiBar() {
  const { data: psiData, isLoading: psiLoading } = useStabilityIndex();
  const { data: stablecoinsData, isLoading: stablecoinsLoading } = useStablecoins();
  const { data: pegData, isLoading: pegLoading } = usePegSummary();
  const { data: dexData, isLoading: dexLoading } = useDexLiquidity();
  const { data: stressData } = useStressSignals();

  const {
    totalMcap,
    mcapChange24hPct,
    mcapChange7dPct,
    usdtUsdcSharePct,
  } = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) {
      return {
        totalMcap: 0,
        mcapChange24hPct: 0,
        mcapChange7dPct: 0,
        usdtUsdcSharePct: 0,
      };
    }

    let total = 0;
    let totalPrev = 0;
    let totalPrevWeek = 0;
    let usdtUsdcTotal = 0;

    for (const coin of stablecoinsData.peggedAssets) {
      const supply = getCirculatingRaw(coin);
      total += supply;
      totalPrev += getPrevDayRaw(coin);
      totalPrevWeek += getPrevWeekRaw(coin);
      const symbol = coin.symbol?.toUpperCase();
      if (symbol === "USDT" || symbol === "USDC") {
        usdtUsdcTotal += supply;
      }
    }

    const pct24h = totalPrev > 0 ? ((total - totalPrev) / totalPrev) * 100 : 0;
    const pct7d = totalPrevWeek > 0 ? ((total - totalPrevWeek) / totalPrevWeek) * 100 : 0;

    return {
      totalMcap: total,
      mcapChange24hPct: pct24h,
      mcapChange7dPct: pct7d,
      usdtUsdcSharePct: total > 0 ? (usdtUsdcTotal / total) * 100 : 0,
    };
  }, [stablecoinsData]);

  const { totalVol24h, volVs7dAvgPct, turnoverPct } = useMemo(() => {
    if (!dexData) return { totalVol24h: 0, volVs7dAvgPct: 0, turnoverPct: 0 };

    let vol24h = 0;
    let vol7d = 0;
    for (const liq of Object.values(dexData)) {
      vol24h += liq.totalVolume24hUsd;
      vol7d += liq.totalVolume7dUsd;
    }

    const avg7d = vol7d / 7;
    const pct = avg7d > 0 ? ((vol24h - avg7d) / avg7d) * 100 : 0;
    const turnover = totalMcap > 0 ? (vol24h / totalMcap) * 100 : 0;
    return { totalVol24h: vol24h, volVs7dAvgPct: pct, turnoverPct: turnover };
  }, [dexData, totalMcap]);

  const psiCurrent = psiData?.current;
  const psiScoreNum = psiCurrent ? (psiCurrent.avg24h ?? psiCurrent.score) : null;
  const psiScore = psiScoreNum !== null ? psiScoreNum.toFixed(1) : "—";
  const psiBand = psiCurrent ? psiCurrent.avg24hBand ?? psiCurrent.band : "";
  const psiColorClass = PSI_BAND_CLASSES[psiBand as ConditionBand] ?? "";

  const { psiDaysInBand, psiDelta24h, psiDelta7d } = useMemo(() => {
    if (!psiBand || !psiData?.history || psiScoreNum === null) {
      return { psiDaysInBand: 0, psiDelta24h: null, psiDelta7d: null };
    }

    let days = 1;
    for (const point of psiData.history) {
      if (point.band === psiBand) days++;
      else break;
    }

    const d24h = psiData.history.length > 0 ? psiScoreNum - psiData.history[0].score : null;
    const d7d = psiData.history.length >= 7 ? psiScoreNum - psiData.history[6].score : null;
    return { psiDaysInBand: days, psiDelta24h: d24h, psiDelta7d: d7d };
  }, [psiBand, psiData, psiScoreNum]);

  const dewsBandCounts = useMemo(() => {
    if (!stressData?.signals) return null;
    let danger = 0;
    let alert = 0;
    let warning = 0;
    for (const entry of Object.values(stressData.signals)) {
      if (entry.band === "DANGER") danger++;
      else if (entry.band === "ALERT") alert++;
      else if (entry.band === "WARNING") warning++;
    }
    return { danger, alert, warning };
  }, [stressData]);

  const isLoading = psiLoading || stablecoinsLoading || pegLoading || dexLoading;

  if (isLoading) {
    return (
      <Card className="pharos-card-shell overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
          <p className="pharos-kicker">Market Snapshot</p>
          <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
        </div>
        <div className="px-3 py-3 sm:hidden">
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="pharos-card-shell min-h-[92px] px-3 py-2.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
            ))}
          </div>
        </div>
        <div className="hidden sm:grid grid-cols-2 xl:grid-cols-4 divide-x divide-border/50">
          {Array.from({ length: 4 }).map((_, i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
      </Card>
    );
  }

  const summary = pegData?.summary;
  const coinsAtPeg = summary?.coinsAtPeg ?? 0;
  const totalTracked = summary?.totalTracked ?? 0;

  const sign24h = mcapChange24hPct >= 0 ? "+" : "";
  const sign7d = mcapChange7dPct >= 0 ? "+" : "";
  const change24h = `${sign24h}${mcapChange24hPct.toFixed(2)}%`;
  const change7d = `${sign7d}${mcapChange7dPct.toFixed(2)}%`;

  const volDeltaValue = `${volVs7dAvgPct >= 0 ? "+" : ""}${volVs7dAvgPct.toFixed(1)}%`;

  const psiDelta24hValue = psiDelta24h !== null ? `${psiDelta24h >= 0 ? "+" : ""}${psiDelta24h.toFixed(1)}` : null;
  const psiDelta7dValue = psiDelta7d !== null ? `${psiDelta7d >= 0 ? "+" : ""}${psiDelta7d.toFixed(1)}` : null;

  const allDewsCalm = dewsBandCounts
    ? dewsBandCounts.danger === 0 && dewsBandCounts.warning === 0 && dewsBandCounts.alert === 0
    : false;

  return (
    <Card className="pharos-card-shell overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
        <p className="pharos-kicker">Market Snapshot</p>
        <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
      </div>

      <div className="px-3 py-3 sm:hidden">
        <div className="grid grid-cols-2 gap-2">
          <KpiMiniTile
            label="PSI"
            value={psiScore}
            valueClassName={psiColorClass}
            metaPrimary={
              psiBand
                ? <span className={psiColorClass || "text-muted-foreground"}>{psiBand} for {psiDaysInBand}d</span>
                : <span className="text-muted-foreground">—</span>
            }
            metaSecondary={
              <>
                <span className={psiDelta24h !== null ? trendTextClass(psiDelta24h) : "text-muted-foreground"}>
                  24h {psiDelta24hValue ?? "—"}
                </span>
                <span className="text-muted-foreground"> · </span>
                <span className={psiDelta7d !== null ? trendTextClass(psiDelta7d) : "text-muted-foreground"}>
                  7d {psiDelta7dValue ?? "—"}
                </span>
              </>
            }
          />
          <KpiMiniTile
            label="Mcap"
            value={formatCurrency(totalMcap, 1)}
            metaPrimary={<span className={trendTextClass(mcapChange24hPct)}>24h {change24h}</span>}
            metaSecondary={<span className={trendTextClass(mcapChange7dPct)}>7d {change7d}</span>}
          />
          <KpiMiniTile
            label="Peg"
            value={`${coinsAtPeg}/${totalTracked}`}
            metaSecondary={
              dewsBandCounts ? (
                <>
                  <span className="text-foreground">DEWS:</span>
                  {dewsBandCounts.danger > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-red-500">Critical {dewsBandCounts.danger}</span>
                    </>
                  )}
                  {dewsBandCounts.warning > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-amber-500">Warning {dewsBandCounts.warning}</span>
                    </>
                  )}
                  {dewsBandCounts.alert > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-amber-500">Alert {dewsBandCounts.alert}</span>
                    </>
                  )}
                  {allDewsCalm && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-muted-foreground">all calm</span>
                    </>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">no DEWS</span>
              )
            }
          />
          <KpiMiniTile
            label="DEX Vol"
            value={formatCurrency(totalVol24h, 1)}
            metaPrimary={<span className={trendTextClass(volVs7dAvgPct)}>vs 7d avg {volDeltaValue}</span>}
            metaSecondary={<span className="text-muted-foreground">Turnover {turnoverPct.toFixed(2)}%</span>}
          />
        </div>
      </div>

      <div className="hidden sm:grid grid-cols-2 xl:grid-cols-4 divide-x divide-border/50">
        <KpiCell
          label="Pharos Stability Index"
          value={psiScore}
          valueClassName={psiColorClass}
          sublabel={
            <>
              {psiBand && (
                <InfoChip label="Band" value={`${psiBand} for ${psiDaysInBand}d`} />
              )}
              {psiDelta24h !== null && (
                <TrendChip
                  label="24h"
                  value={`${psiDelta24h >= 0 ? "+" : ""}${psiDelta24h.toFixed(1)}`}
                  direction={trendDirection(psiDelta24h)}
                />
              )}
            </>
          }
        />

        <KpiCell
          label="Total Stablecoin Mcap"
          value={formatCurrency(totalMcap, 1)}
          sublabel={
            <>
              <TrendChip label="24h" value={change24h} direction={trendDirection(mcapChange24hPct)} />
              <InfoChip label="USDT+USDC share" value={`${usdtUsdcSharePct.toFixed(1)}%`} tone={usdtUsdcSharePct >= 65 ? "warning" : "neutral"} />
            </>
          }
        />

        <KpiCell
          label="Peg Status"
          value={`${coinsAtPeg} / ${totalTracked}`}
          sublabel={
            <>
              <span className="pharos-kicker">DEWS:</span>
              {dewsBandCounts && dewsBandCounts.danger > 0 && <DewsBandChip band="DANGER" count={dewsBandCounts.danger} />}
              {dewsBandCounts && dewsBandCounts.warning > 0 && <DewsBandChip band="WARNING" count={dewsBandCounts.warning} />}
              {dewsBandCounts && dewsBandCounts.alert > 0 && <DewsBandChip band="ALERT" count={dewsBandCounts.alert} />}
              {dewsBandCounts && allDewsCalm && <span className="text-[11px] text-muted-foreground">all calm</span>}
              {!dewsBandCounts && <span className="text-[11px] text-muted-foreground">no data</span>}
            </>
          }
        />

        <KpiCell
          label="Tracked 24H DEX Vol"
          value={formatCurrency(totalVol24h, 1)}
          sublabel={
            <>
              <TrendChip label="vs 7d avg" value={volDeltaValue} direction={trendDirection(volVs7dAvgPct)} />
              <InfoChip label="Turnover" value={`${turnoverPct.toFixed(2)}%`} />
            </>
          }
        />
      </div>
    </Card>
  );
}
