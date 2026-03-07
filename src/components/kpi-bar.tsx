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
import { QueryErrorNotice } from "@/components/query-error-notice";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { formatCurrency } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { THREAT_BAND_COLORS, type ThreatBand } from "@shared/lib/classification";

type TrendDirection = "up" | "down" | "flat";
type ElevatedThreatBand = Extract<ThreatBand, "DANGER" | "ALERT" | "WARNING">;
const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);
const KPI_CHIP_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-[inset_0_1px_0_oklch(1_0_0_/0.2)] transition-colors";

function trendDirection(value: number): TrendDirection {
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function trendTextClass(value: number): string {
  if (value > 0) return "text-green-700 dark:text-green-400";
  if (value < 0) return "text-red-700 dark:text-red-400";
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
    ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400"
    : direction === "down"
      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
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
    ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400"
    : tone === "negative"
      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
    : tone === "warning"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
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
  const psiQuery = useStabilityIndex();
  const stablecoinsQuery = useStablecoins();
  const { data: psiData, isLoading: psiLoading } = psiQuery;
  const { data: stablecoinsData, isLoading: stablecoinsLoading } = stablecoinsQuery;
  const { data: pegData, isLoading: pegLoading } = usePegSummary();
  const { data: dexData, isLoading: dexLoading } = useDexLiquidity();
  const { data: stressData } = useStressSignals();
  const primaryError = stablecoinsQuery.error || psiQuery.error;
  const hasPrimaryData = !!psiData || !!stablecoinsData;

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
  const hasStablecoinsData = !!stablecoinsData?.peggedAssets;
  const hasPsiData = !!psiCurrent;
  const hasDexData = !!dexData;
  const summary = pegData?.summary;
  const hasSummary = !!summary;
  const psiScoreDisplay = hasPsiData ? psiScore : "—";
  const psiBandDisplay = hasPsiData ? psiBand : "";
  const mcapDisplay = hasStablecoinsData ? formatCurrency(totalMcap, 1) : "—";
  const mcapChange24Display = hasStablecoinsData ? `${mcapChange24hPct >= 0 ? "+" : ""}${mcapChange24hPct.toFixed(2)}%` : "—";
  const mcapChange7Display = hasStablecoinsData ? `${mcapChange7dPct >= 0 ? "+" : ""}${mcapChange7dPct.toFixed(2)}%` : "—";
  const mcapColorClass = hasStablecoinsData ? trendTextClass(mcapChange24hPct) : "text-muted-foreground";
  const mcap7ColorClass = hasStablecoinsData ? trendTextClass(mcapChange7dPct) : "text-muted-foreground";
  const pegStatusDisplay = hasSummary ? `${summary.coinsAtPeg}/${summary.totalTracked}` : "—";
  const usdtShareDisplay = hasStablecoinsData ? `${usdtUsdcSharePct.toFixed(1)}%` : "—";
  const dexVolDisplay = hasDexData ? formatCurrency(totalVol24h, 1) : "—";
  const dexDeltaDisplay = hasDexData ? `${volVs7dAvgPct >= 0 ? "+" : ""}${volVs7dAvgPct.toFixed(1)}%` : "—";
  const turnoverDisplay = hasStablecoinsData && hasDexData && totalMcap > 0 ? `${turnoverPct.toFixed(2)}%` : "—";

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
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
          <p className="pharos-kicker">Market Snapshot</p>
          <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
        </div>
        <div className="px-3 py-3 sm:hidden">
          <div className="grid grid-cols-2 gap-2">
            {SKELETON_CARDS.map((i) => (
              <div key={i} className="pharos-card-shell min-h-[92px] px-3 py-2.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
            ))}
          </div>
        </div>
        <div className="hidden sm:grid grid-cols-2 xl:grid-cols-4 divide-x divide-border/50">
          {SKELETON_CARDS.map((i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
      </Card>
    );
  }

  const psiDelta24hValue = psiDelta24h !== null ? `${psiDelta24h >= 0 ? "+" : ""}${psiDelta24h.toFixed(1)}` : null;
  const psiDelta7dValue = psiDelta7d !== null ? `${psiDelta7d >= 0 ? "+" : ""}${psiDelta7d.toFixed(1)}` : null;

  const allDewsCalm = dewsBandCounts
    ? dewsBandCounts.danger === 0 && dewsBandCounts.warning === 0 && dewsBandCounts.alert === 0
    : false;

  return (
    <Card className="pharos-card-shell overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
        <p className="pharos-kicker">Market Snapshot</p>
        <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
      </div>

      {primaryError && (
        <div className="px-3 pt-3">
          <QueryErrorNotice
            error={primaryError}
            hasData={hasPrimaryData}
            onRetry={() => {
              void Promise.all([psiQuery.refetch(), stablecoinsQuery.refetch()]);
            }}
          />
        </div>
      )}

      <div className="px-3 py-3 sm:hidden">
        <div className="grid grid-cols-2 gap-2">
          <KpiMiniTile
            label="PSI"
            value={psiScoreDisplay}
            valueClassName={hasPsiData ? psiColorClass : "text-muted-foreground"}
            metaPrimary={
              hasPsiData
                ? <span className={psiColorClass || "text-muted-foreground"}>{psiBandDisplay} for {psiDaysInBand}d</span>
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
            value={mcapDisplay}
            metaPrimary={<span className={mcapColorClass}>24h {mcapChange24Display}</span>}
            metaSecondary={<span className={mcap7ColorClass}>7d {mcapChange7Display}</span>}
          />
          <KpiMiniTile
            label="Peg"
            value={pegStatusDisplay}
            metaSecondary={
              dewsBandCounts ? (
                <>
                  <span className="text-foreground">DEWS:</span>
                  {dewsBandCounts.danger > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-red-700 dark:text-red-400">Critical {dewsBandCounts.danger}</span>
                    </>
                  )}
                  {dewsBandCounts.warning > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-amber-700 dark:text-amber-400">Warning {dewsBandCounts.warning}</span>
                    </>
                  )}
                  {dewsBandCounts.alert > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-amber-700 dark:text-amber-400">Alert {dewsBandCounts.alert}</span>
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
            value={dexVolDisplay}
            metaPrimary={<span className={hasDexData ? trendTextClass(volVs7dAvgPct) : "text-muted-foreground"}>vs 7d avg {dexDeltaDisplay}</span>}
            metaSecondary={<span className="text-muted-foreground">Turnover {turnoverDisplay}</span>}
          />
        </div>
      </div>

      <div className="hidden sm:grid grid-cols-2 xl:grid-cols-4 divide-x divide-border/50">
        <KpiCell
          label="Pharos Stability Index"
          value={psiScoreDisplay}
          valueClassName={hasPsiData ? psiColorClass : "text-muted-foreground"}
          sublabel={
            <>
              {hasPsiData ? (
                <InfoChip label="Band" value={`${psiBandDisplay} for ${psiDaysInBand}d`} />
              ) : (
                <span className="text-muted-foreground">—</span>
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
          value={mcapDisplay}
          sublabel={
            <>
              <TrendChip label="24h" value={mcapChange24Display} direction={hasStablecoinsData ? trendDirection(mcapChange24hPct) : "flat"} />
              <InfoChip
                label="USDT+USDC share"
                value={usdtShareDisplay}
                tone={hasStablecoinsData && usdtUsdcSharePct >= 65 ? "warning" : "neutral"}
              />
            </>
          }
        />

        <KpiCell
          label="Peg Status"
          value={pegStatusDisplay}
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
          value={dexVolDisplay}
          sublabel={
            <>
              <TrendChip label="vs 7d avg" value={dexDeltaDisplay} direction={hasDexData ? trendDirection(volVs7dAvgPct) : "flat"} />
              <InfoChip label="Turnover" value={turnoverDisplay} />
            </>
          }
        />
      </div>
    </Card>
  );
}
