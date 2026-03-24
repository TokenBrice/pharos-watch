"use client";

import { useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useDexLiquidity, usePegSummary, useStabilityIndex, useStressSignals } from "@/hooks/api-hooks";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useCountUp } from "@/hooks/use-count-up";
import { useEntranceSequence } from "@/hooks/use-entrance-sequence";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { formatCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import {
  getDisplayedPsi,
  getPsiBandStreak,
  getPsiCompletedDayPoint,
} from "@shared/lib/psi-view-model";
import { THREAT_BAND_COLORS, type ThreatBand } from "@shared/lib/classification";

type TrendDirection = "up" | "down" | "flat";
type ElevatedThreatBand = Extract<ThreatBand, "DANGER" | "ALERT" | "WARNING">;
const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);
const KPI_CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-[inset_0_1px_0_oklch(1_0_0_/0.2)] transition-colors";
const SNAPSHOT_PILL_BASE =
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-sm";

function trendDirection(value: number): TrendDirection {
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function trendTextClass(value: number): string {
  if (value > 0) return "text-[var(--severity-healthy)]";
  if (value < 0) return "text-[var(--severity-severe)]";
  return "text-muted-foreground";
}

function formatSignedCompactCurrency(value: number, decimals = 1): string {
  return `${getNetPrefix(value)}${formatCurrency(value, decimals)}`;
}

/** Decompose a large number into an abbreviated value + suffix (e.g., 234.5B → { short: 234.5, suffix: "B" }). */
function abbreviate(value: number): { short: number; suffix: string } {
  const abs = Math.abs(value);
  if (abs >= 1e12) return { short: value / 1e12, suffix: "T" };
  if (abs >= 1e9) return { short: value / 1e9, suffix: "B" };
  if (abs >= 1e6) return { short: value / 1e6, suffix: "M" };
  if (abs >= 1e3) return { short: value / 1e3, suffix: "K" };
  return { short: value, suffix: "" };
}

function TrendChip({ label, value, direction }: { label: string; value: string; direction: TrendDirection }) {
  const toneClasses =
    direction === "up"
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
  const toneClasses =
    tone === "positive"
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
  centered = false,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  valueClassName?: string;
  centered?: boolean;
  className?: string;
}) {
  if (centered) {
    return (
      <div className={`flex h-full flex-col items-center justify-center gap-1.5 px-4 py-3 text-center ${className}`}>
        <span className="pharos-kicker">{label}</span>
        <span className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
          {value}
        </span>
        {sublabel && <div className="flex flex-wrap items-center justify-center gap-1 pt-0.5 text-xs">{sublabel}</div>}
      </div>
    );
  }
  return (
    <div className={`flex min-h-[92px] flex-col justify-between gap-2 px-4 py-3 ${className}`}>
      <span className="pharos-kicker">{label}</span>
      <span className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
        {value}
      </span>
      {sublabel && <div className="flex flex-wrap items-center gap-1 pb-1 text-xs">{sublabel}</div>}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="flex min-h-[92px] flex-col justify-between gap-2 px-4 py-3">
      <Skeleton className="h-3.5 w-20" />
      <Skeleton className="h-7 w-24" />
      <div className="flex items-center gap-1.5">
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
    <div className="pharos-card-shell flex min-h-[96px] flex-col px-3 py-2.5">
      <p className="pharos-kicker tracking-[0.08em]">{label}</p>
      <p className={`mt-1 text-lg font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
        {value}
      </p>
      {(metaPrimary || metaSecondary) && (
        <div className="mt-auto space-y-0.5 pt-2 text-[11px] font-mono leading-snug">
          {metaPrimary && <div>{metaPrimary}</div>}
          {metaSecondary && <div>{metaSecondary}</div>}
        </div>
      )}
    </div>
  );
}

interface KpiMetricDefinition {
  key: string;
  mobileLabel: string;
  desktopLabel: string;
  value: React.ReactNode;
  mobileMetaPrimary?: React.ReactNode;
  mobileMetaSecondary?: React.ReactNode;
  desktopSublabel?: React.ReactNode;
  mobileValueClassName?: string;
  desktopValueClassName?: string;
}

function PrimarySnapshotCard({
  value,
  band,
  delta24h,
  delta7d,
  delta30d,
  valueClassName,
}: {
  value: string;
  band: string;
  delta24h: string | null;
  delta7d: string | null;
  delta30d: string | null;
  valueClassName?: string;
}) {
  // Detect crisis/meltdown bands for alert styling
  const isCrisis = band.toLowerCase().includes("crisis") || band.toLowerCase().includes("meltdown");
  const isTremor = band.toLowerCase().includes("tremor") || band.toLowerCase().includes("fracture");

  return (
    <div
      className={`rounded-[1.4rem] border px-4 py-3.5 transition-all duration-500 sm:px-5 sm:py-4 ${
        isCrisis ? "animate-pulse" : ""
      }`}
      style={{
        background: "var(--surface-featured-gradient)",
        borderColor: isCrisis ? "var(--p-red-400)" : isTremor ? "var(--p-amber-400)" : "var(--surface-featured-border)",
        boxShadow: isCrisis
          ? "var(--surface-featured-shadow), 0 0 30px oklch(0.7 0.2 25 / 0.3)"
          : isTremor
            ? "var(--surface-featured-shadow), 0 0 20px oklch(0.75 0.15 85 / 0.2)"
            : "var(--surface-featured-shadow)",
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-2">
          <div className="flex w-fit flex-col items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-center text-[14px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-primary/80 sm:text-[13px]">
                PSI
              </p>
              <span className="relative flex h-2 w-2">
                <span className="animate-breathe absolute inline-flex h-full w-full rounded-full bg-green-400"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            </div>
            <div
              className={`font-mono text-[3.2rem] font-extrabold leading-none tabular-nums sm:text-[3.4rem] ${valueClassName ?? ""}`}
            >
              {value}
            </div>
          </div>
          <p className={`text-sm font-semibold whitespace-nowrap ${valueClassName ?? "text-foreground"}`}>
            {band || "No current PSI band"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center gap-2 min-[1024px]:max-[1599px]:hidden">
          <div className="flex flex-col items-end gap-2">
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap border-slate-300/70 bg-white/76 text-slate-600 dark:border-white/8 dark:bg-black/18 dark:text-slate-300`}
            >
              24h {delta24h ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap border-slate-300/70 bg-white/76 text-slate-600 dark:border-white/8 dark:bg-black/18 dark:text-slate-300`}
            >
              7d {delta7d ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap border-slate-300/70 bg-white/76 text-slate-600 dark:border-white/8 dark:bg-black/18 dark:text-slate-300`}
            >
              30d {delta30d ?? "—"}
            </span>
          </div>
        </div>
      </div>
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
  const { data: flowData } = useMintBurnFlows(24);
  const { data: stressData } = useStressSignals();
  const primaryError = stablecoinsQuery.error || psiQuery.error;
  const hasPrimaryData = !!psiData || !!stablecoinsData;

  const { totalMcap, mcapChange24hPct, mcapChange7dPct, usdtUsdcSharePct } = useMemo(() => {
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

  const { netFlow24h, netFlow7d } = useMemo(() => {
    if (!flowData?.coins?.length) {
      return { netFlow24h: 0, netFlow7d: 0 };
    }

    let total24h = 0;
    let total7d = 0;
    for (const coin of flowData.coins) {
      total24h += coin.netFlow24hUsd;
      total7d += coin.netFlow7dUsd;
    }

    return {
      netFlow24h: total24h,
      netFlow7d: total7d,
    };
  }, [flowData]);

  const psiCurrent = psiData?.current;
  const displayedPsi = psiCurrent ? getDisplayedPsi(psiCurrent) : null;
  const psiScoreNum = displayedPsi?.score ?? null;
  const psiBand = displayedPsi?.band ?? "";
  const psiDayAnchor = psiCurrent?.computedAt ?? null;
  const psiColorClass = PSI_BAND_CLASSES[psiBand as ConditionBand] ?? "";
  const hasStablecoinsData = !!stablecoinsData?.peggedAssets;
  const hasPsiData = !!psiCurrent;
  const hasDexData = !!dexData;
  const summary = pegData?.summary;
  const hasSummary = !!summary;
  const psiBandDisplay = hasPsiData ? psiBand : "";
  const mcapChange24Display = hasStablecoinsData
    ? `${mcapChange24hPct >= 0 ? "+" : ""}${mcapChange24hPct.toFixed(2)}%`
    : "—";
  const mcapChange7Display = hasStablecoinsData
    ? `${mcapChange7dPct >= 0 ? "+" : ""}${mcapChange7dPct.toFixed(2)}%`
    : "—";
  const mcapColorClass = hasStablecoinsData ? trendTextClass(mcapChange24hPct) : "text-muted-foreground";
  const mcap7ColorClass = hasStablecoinsData ? trendTextClass(mcapChange7dPct) : "text-muted-foreground";
  const pegStatusDisplay = hasSummary ? `${summary.coinsAtPeg}/${summary.totalTracked}` : "—";
  const usdtShareDisplay = hasStablecoinsData ? `${usdtUsdcSharePct.toFixed(1)}%` : "—";
  const dexVolDisplay = hasDexData ? formatCurrency(totalVol24h, 1) : "—";
  const dexDeltaDisplay = hasDexData ? `${volVs7dAvgPct >= 0 ? "+" : ""}${volVs7dAvgPct.toFixed(1)}%` : "—";
  const turnoverDisplay = hasStablecoinsData && hasDexData && totalMcap > 0 ? `${turnoverPct.toFixed(2)}%` : "—";
  const hasFlowData = !!flowData?.coins?.length;
  const netFlow24Display = hasFlowData ? formatSignedCompactCurrency(netFlow24h, 1) : "—";
  const netFlow7Display = hasFlowData ? formatSignedCompactCurrency(netFlow7d, 1) : "—";
  const netFlow24Class = hasFlowData ? getNetColor(netFlow24h) : "text-muted-foreground";
  const netFlow7Class = hasFlowData ? getNetColor(netFlow7d) : "text-muted-foreground";
  const netFlow7Tone: "neutral" | "positive" | "negative" = !hasFlowData
    ? "neutral"
    : netFlow7d > 0
      ? "positive"
      : netFlow7d < 0
        ? "negative"
        : "neutral";

  const { psiDaysInBand, psiDelta24h, psiDelta7d, psiDelta30d } = useMemo(() => {
    if (!psiBand || !psiData?.history || psiScoreNum === null || psiDayAnchor === null) {
      return { psiDaysInBand: 0, psiDelta24h: null, psiDelta7d: null, psiDelta30d: null };
    }

    const previousDay = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 1);
    const previousWeek = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 7);
    const previousMonth = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 30);

    return {
      psiDaysInBand: getPsiBandStreak(psiData.history, psiDayAnchor, psiBand),
      psiDelta24h: previousDay ? psiScoreNum - previousDay.score : null,
      psiDelta7d: previousWeek ? psiScoreNum - previousWeek.score : null,
      psiDelta30d: previousMonth ? psiScoreNum - previousMonth.score : null,
    };
  }, [psiBand, psiData, psiDayAnchor, psiScoreNum]);

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

  /* ---------- entrance choreography (hooks must be called unconditionally) ---------- */
  const { delayFor } = useEntranceSequence();

  /* ---------- count-up animations (hooks must be called unconditionally) ---------- */
  const mcapAbbr = abbreviate(totalMcap);
  const animatedPsi = useCountUp(psiScoreNum ?? 0, { decimals: 1 });
  const animatedMcap = useCountUp(mcapAbbr.short, {
    decimals: 1,
    prefix: "$",
    suffix: mcapAbbr.suffix,
  });
  const psiScoreDisplay = hasPsiData ? animatedPsi : "—";
  const mcapDisplay = hasStablecoinsData ? animatedMcap : "—";

  const isLoading = psiLoading || stablecoinsLoading || pegLoading || dexLoading;

  if (isLoading) {
    return (
      <Card className="pharos-card-shell overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
          <p className="pharos-kicker">Market Snapshot</p>
          <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
        </div>
        <div className="space-y-2.5 px-3 py-3 lg:hidden">
          <div className="rounded-2xl border border-border/60 bg-background/40 px-4 py-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-10 w-28" />
            <div className="mt-3 flex gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
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
        <div className="hidden grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/50 lg:grid">
          <div className="px-4 py-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-3 h-14 w-32" />
            <div className="mt-4 flex gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
          {SKELETON_CARDS.map((i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
      </Card>
    );
  }

  const psiDelta24hValue = psiDelta24h !== null ? `${psiDelta24h >= 0 ? "+" : ""}${psiDelta24h.toFixed(1)}` : null;
  const psiDelta7dValue = psiDelta7d !== null ? `${psiDelta7d >= 0 ? "+" : ""}${psiDelta7d.toFixed(1)}` : null;
  const psiDelta30dValue = psiDelta30d !== null ? `${psiDelta30d >= 0 ? "+" : ""}${psiDelta30d.toFixed(1)}` : null;

  const allDewsCalm = dewsBandCounts
    ? dewsBandCounts.danger === 0 && dewsBandCounts.warning === 0 && dewsBandCounts.alert === 0
    : false;
  const mobileDewsMeta = dewsBandCounts ? (
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
  );

  const desktopDewsSublabel = (
    <>
      <span className="pharos-kicker">DEWS:</span>
      {dewsBandCounts?.danger ? <DewsBandChip band="DANGER" count={dewsBandCounts.danger} /> : null}
      {dewsBandCounts?.warning ? <DewsBandChip band="WARNING" count={dewsBandCounts.warning} /> : null}
      {dewsBandCounts?.alert ? <DewsBandChip band="ALERT" count={dewsBandCounts.alert} /> : null}
      {dewsBandCounts ? (
        allDewsCalm ? (
          <span className="text-[11px] text-muted-foreground">all calm</span>
        ) : null
      ) : (
        <span className="text-[11px] text-muted-foreground">no data</span>
      )}
    </>
  );

  const metricDefinitions: KpiMetricDefinition[] = [
    {
      key: "mcap",
      mobileLabel: "Mcap",
      desktopLabel: "Total Stablecoin Mcap",
      value: mcapDisplay,
      mobileMetaPrimary: <span className={mcapColorClass}>24h {mcapChange24Display}</span>,
      mobileMetaSecondary: <span className={mcap7ColorClass}>7d {mcapChange7Display}</span>,
      desktopSublabel: (
        <>
          <TrendChip
            label="24h"
            value={mcapChange24Display}
            direction={hasStablecoinsData ? trendDirection(mcapChange24hPct) : "flat"}
          />
          <InfoChip
            label="USDT+USDC share"
            value={usdtShareDisplay}
            tone={hasStablecoinsData && usdtUsdcSharePct >= 65 ? "warning" : "neutral"}
          />
        </>
      ),
    },
    {
      key: "peg",
      mobileLabel: "Peg",
      desktopLabel: "Peg Status",
      value: pegStatusDisplay,
      mobileMetaSecondary: mobileDewsMeta,
      desktopSublabel: desktopDewsSublabel,
    },
    {
      key: "dex-vol",
      mobileLabel: "DEX Vol",
      desktopLabel: "Tracked 24H DEX Vol",
      value: dexVolDisplay,
      mobileMetaPrimary: (
        <span className={hasDexData ? trendTextClass(volVs7dAvgPct) : "text-muted-foreground"}>
          vs 7d avg {dexDeltaDisplay}
        </span>
      ),
      mobileMetaSecondary: <span className="text-muted-foreground">Turnover {turnoverDisplay}</span>,
      desktopSublabel: (
        <>
          <TrendChip
            label="vs 7d avg"
            value={dexDeltaDisplay}
            direction={hasDexData ? trendDirection(volVs7dAvgPct) : "flat"}
          />
          <InfoChip label="Turnover" value={turnoverDisplay} />
        </>
      ),
    },
    {
      key: "net-flow",
      mobileLabel: "Net Flow",
      desktopLabel: "Net Mint/Burn Flow",
      value: netFlow24Display,
      mobileMetaPrimary: <span className={netFlow7Class}>7d {netFlow7Display}</span>,
      desktopSublabel: <InfoChip label="7d total" value={netFlow7Display} tone={netFlow7Tone} />,
      mobileValueClassName: netFlow24Class,
      desktopValueClassName: netFlow24Class,
    },
  ];

  return (
    <Card className="pharos-card-shell overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
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

      <div className="space-y-2.5 px-3 py-3 lg:hidden">
        <div
          style={{
            animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
            animationDelay: `${delayFor("kpi", 0)}ms`,
          }}
        >
          <PrimarySnapshotCard
            value={psiScoreDisplay}
            band={hasPsiData ? `${psiBandDisplay} for ${psiDaysInBand}d` : ""}
            delta24h={psiDelta24hValue}
            delta7d={psiDelta7dValue}
            delta30d={psiDelta30dValue}
            valueClassName={hasPsiData ? psiColorClass : "text-muted-foreground"}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {metricDefinitions.map((metric, i) => (
            <div
              key={metric.key}
              style={{
                animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
                animationDelay: `${delayFor("kpi", i + 1)}ms`,
              }}
            >
              <KpiMiniTile
                label={metric.mobileLabel}
                value={metric.value}
                metaPrimary={metric.mobileMetaPrimary}
                metaSecondary={metric.mobileMetaSecondary}
                valueClassName={metric.mobileValueClassName}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="hidden grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/50 lg:grid">
        <div
          className="px-4 py-3"
          style={{
            animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
            animationDelay: `${delayFor("kpi", 0)}ms`,
          }}
        >
          <PrimarySnapshotCard
            value={psiScoreDisplay}
            band={hasPsiData ? `${psiBandDisplay} for ${psiDaysInBand}d` : ""}
            delta24h={psiDelta24hValue}
            delta7d={psiDelta7dValue}
            delta30d={psiDelta30dValue}
            valueClassName={hasPsiData ? psiColorClass : "text-muted-foreground"}
          />
        </div>

        {metricDefinitions.map((metric, i) => (
          <div
            key={metric.key}
            className="h-full flex"
            style={{
              animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
              animationDelay: `${delayFor("kpi", i + 1)}ms`,
            }}
          >
            <KpiCell
              label={metric.desktopLabel}
              value={metric.value}
              valueClassName={`text-lg${metric.desktopValueClassName ? ` ${metric.desktopValueClassName}` : ""}`}
              sublabel={metric.desktopSublabel}
              centered
              className="flex-1"
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
