"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useDexLiquidity, usePegSummary, useStabilityIndex, useStressSignals } from "@/hooks/api-hooks";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useCountUp } from "@/hooks/use-count-up";
import { useEntranceSequence } from "@/hooks/use-entrance-sequence";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { abbreviateNumberParts, formatCurrency, formatSignedCurrency, getNetColor, timeAgo } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import {
  buildDewsBandCounts,
  buildDexSnapshot,
  buildFlowSnapshot,
  buildPsiSnapshot,
  buildStablecoinSnapshot,
} from "@/components/kpi-bar-view-model";
import { MethodologyLabel } from "@/components/methodology-hint";

type TrendDirection = "up" | "down" | "flat";
const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);
const KPI_CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-[inset_0_1px_0_oklch(1_0_0_/0.2)] transition-colors";
const SNAPSHOT_PILL_BASE =
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";

function trendDirection(value: number): TrendDirection {
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function trendTextClass(value: number): string {
  if (value > 0) return "text-[var(--severity-healthy)]";
  if (value < 0) return "text-[var(--severity-severe)]";
  return "text-muted-foreground";
}

function TrendChip({ label, value, direction }: { label: React.ReactNode; value: string; direction: TrendDirection }) {
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
  label: React.ReactNode;
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

function KpiCell({
  label,
  value,
  sublabel,
  valueClassName,
  centered = false,
  className = "",
}: {
  label: React.ReactNode;
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
        <span aria-live="polite" className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
          {value}
        </span>
        {sublabel && <div className="flex flex-wrap items-center justify-center gap-1 pt-0.5 text-xs">{sublabel}</div>}
      </div>
    );
  }
  return (
    <div className={`flex min-h-[92px] flex-col justify-between gap-2 px-4 py-3 ${className}`}>
      <span className="pharos-kicker">{label}</span>
      <span aria-live="polite" className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
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
  desktopLabel: React.ReactNode;
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
  const isElevated = isCrisis || isTremor;

  return (
    <div
      className={`@container rounded-[1.4rem] border px-4 py-3.5 transition-all duration-500 @sm:px-5 @sm:py-4 ${
        isCrisis ? "animate-pulse" : ""
      }`}
      style={{
        background: isElevated 
          ? "var(--surface-featured-gradient), linear-gradient(135deg, oklch(0.7 0.15 25 / 0.08) 0%, transparent 50%)"
          : "var(--surface-featured-gradient)",
        borderColor: isCrisis ? "var(--p-red-400)" : isTremor ? "var(--p-amber-400)" : "var(--surface-featured-border)",
        boxShadow: isCrisis
          ? "var(--surface-featured-shadow), 0 0 30px oklch(0.7 0.2 25 / 0.35)"
          : isTremor
            ? "var(--surface-featured-shadow), 0 0 20px oklch(0.75 0.15 85 / 0.25)"
            : "var(--surface-featured-shadow)",
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-2">
          <div className="flex w-fit flex-col items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-center text-[14px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-primary/80 @sm:text-[13px]">
                PSI
              </p>
              <span className="relative flex h-2 w-2">
                <span className={`animate-breathe absolute inline-flex h-full w-full rounded-full ${isElevated ? "bg-red-400" : "bg-green-400"}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isElevated ? "bg-red-500" : "bg-green-500"}`}></span>
              </span>
            </div>
            <div
              aria-live="polite"
              className={`font-mono text-[3.2rem] font-extrabold leading-none tabular-nums @sm:text-[3.4rem] ${valueClassName ?? ""}`}
            >
              {value}
            </div>
          </div>
          {/* Enhanced band display for stress states */}
          <div className={`flex items-center gap-1.5 ${isElevated ? "rounded-lg bg-red-500/10 px-2 py-1 -mx-1" : ""}`}>
            {isCrisis && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
            )}
            <p className={`font-semibold whitespace-nowrap ${isElevated ? "text-base" : "text-sm"} ${valueClassName ?? "text-foreground"}`}>
              {band || "No current PSI band"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center gap-2">
          <div className="flex flex-col items-end gap-2">
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
            >
              24h {delta24h ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
            >
              7d {delta7d ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
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
  const { data: pegData, isLoading: pegLoading, error: pegError } = usePegSummary();
  const { data: dexData, isLoading: dexLoading, error: dexError } = useDexLiquidity();
  const { data: flowData, isLoading: flowLoading, error: flowError } = useMintBurnFlows(24);
  const { data: stressData, isLoading: stressLoading, error: stressError } = useStressSignals();
  const primaryError = stablecoinsQuery.error || psiQuery.error || pegError || dexError || flowError || stressError;
  const hasPrimaryData = !!psiData || !!stablecoinsData;
  const lastUpdatedAt = Math.max(stablecoinsQuery.dataUpdatedAt ?? 0, psiQuery.dataUpdatedAt ?? 0);

  const { totalMcap, mcapChange24hPct, mcapChange7dPct, usdtUsdcSharePct } = useMemo(
    () => buildStablecoinSnapshot(stablecoinsData),
    [stablecoinsData],
  );
  const { totalVol24h, volVs7dAvgPct, turnoverPct } = useMemo(
    () => buildDexSnapshot(dexData, totalMcap),
    [dexData, totalMcap],
  );
  const { netFlow24h, netFlow7d } = useMemo(() => buildFlowSnapshot(flowData), [flowData]);
  const { psiCurrent, psiScoreNum, psiBand, psiDaysInBand, psiDelta24h, psiDelta7d, psiDelta30d } =
    useMemo(() => buildPsiSnapshot(psiData), [psiData]);
  const psiColorClass = psiBand && psiBand in PSI_BAND_CLASSES ? PSI_BAND_CLASSES[psiBand as ConditionBand] : "";
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
  const netFlow24Display = hasFlowData ? formatSignedCurrency(netFlow24h, 1) : "—";
  const netFlow7Display = hasFlowData ? formatSignedCurrency(netFlow7d, 1) : "—";
  const netFlow24Class = hasFlowData ? getNetColor(netFlow24h) : "text-muted-foreground";
  const netFlow7Class = hasFlowData ? getNetColor(netFlow7d) : "text-muted-foreground";
  const netFlow7Tone: "neutral" | "positive" | "negative" = !hasFlowData
    ? "neutral"
    : netFlow7d > 0
      ? "positive"
      : netFlow7d < 0
        ? "negative"
        : "neutral";

  const dewsBandCounts = useMemo(() => buildDewsBandCounts(stressData), [stressData]);

  /* ---------- entrance choreography (hooks must be called unconditionally) ---------- */
  const { delayFor } = useEntranceSequence();

  /* ---------- count-up animations (hooks must be called unconditionally) ---------- */
  const mcapAbbr = abbreviateNumberParts(totalMcap);
  const animatedPsi = useCountUp(psiScoreNum ?? 0, { decimals: 1 });
  const animatedMcap = useCountUp(mcapAbbr.short, {
    decimals: 1,
    prefix: "$",
    suffix: mcapAbbr.suffix,
  });
  const psiScoreDisplay = hasPsiData ? animatedPsi : "—";
  const mcapDisplay = hasStablecoinsData ? animatedMcap : "—";

  const isLoading = psiLoading || stablecoinsLoading || pegLoading || dexLoading || flowLoading || stressLoading;

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
        <div className="hidden grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/30 lg:grid items-stretch">
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

  const dewsElevatedCount = dewsBandCounts
    ? dewsBandCounts.danger + dewsBandCounts.warning + dewsBandCounts.alert
    : 0;
  const allDewsCalm = !!dewsBandCounts && dewsElevatedCount === 0;
  // Severity tokens mirror the DEWS radar so the snapshot pill stays in lockstep with band language.
  const dewsSeverityClass = !dewsBandCounts
    ? "text-muted-foreground"
    : dewsBandCounts.danger > 0
      ? "text-[color:var(--dews-danger)]"
      : dewsBandCounts.warning > 0
        ? "text-[color:var(--dews-warning)]"
        : dewsBandCounts.alert > 0
          ? "text-[color:var(--dews-alert)]"
          : "text-muted-foreground";
  const mobileDewsMeta = dewsBandCounts ? (
    allDewsCalm ? (
      <span className="text-muted-foreground">DEWS all calm</span>
    ) : (
      <span className={dewsSeverityClass}>
        DEWS {dewsElevatedCount} on alert
      </span>
    )
  ) : (
    <span className="text-muted-foreground">no DEWS</span>
  );

  const desktopDewsSublabel = dewsBandCounts ? (
    allDewsCalm ? (
      <span className="text-[11px] text-muted-foreground">DEWS all calm</span>
    ) : (
      <span className={`text-[11px] ${dewsSeverityClass}`}>DEWS {dewsElevatedCount} on alert</span>
    )
  ) : (
    <span className="text-[11px] text-muted-foreground">DEWS no data</span>
  );

  const metricDefinitions: KpiMetricDefinition[] = [
    {
      key: "mcap",
      mobileLabel: "Market Cap",
      desktopLabel: <MethodologyLabel topic="totalStablecoinMcap">Total Stablecoin Mcap</MethodologyLabel>,
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
            label="USDT + USDC share"
            value={usdtShareDisplay}
            tone={hasStablecoinsData && usdtUsdcSharePct >= 65 ? "warning" : "neutral"}
          />
        </>
      ),
    },
    {
      key: "peg",
      mobileLabel: "Peg",
      desktopLabel: <MethodologyLabel topic="pegStatus">Peg Status</MethodologyLabel>,
      value: pegStatusDisplay,
      mobileMetaSecondary: mobileDewsMeta,
      desktopSublabel: desktopDewsSublabel,
    },
    {
      key: "dex-vol",
      mobileLabel: "DEX Volume",
      desktopLabel: <MethodologyLabel topic="trackedDexVol">Tracked 24H DEX Vol</MethodologyLabel>,
      value: dexVolDisplay,
      mobileMetaPrimary: (
        <span className={hasDexData ? trendTextClass(volVs7dAvgPct) : "text-muted-foreground"}>
          vs 7d average {dexDeltaDisplay}
        </span>
      ),
      mobileMetaSecondary: <span className="text-muted-foreground">Turnover {turnoverDisplay}</span>,
      desktopSublabel: (
        <>
          <TrendChip
            label={<MethodologyLabel topic="dexVolVsAvg">vs 7d avg</MethodologyLabel>}
            value={dexDeltaDisplay}
            direction={hasDexData ? trendDirection(volVs7dAvgPct) : "flat"}
          />
          <InfoChip label={<MethodologyLabel topic="turnover">Turnover</MethodologyLabel>} value={turnoverDisplay} />
        </>
      ),
    },
    {
      key: "net-flow",
      mobileLabel: "Net Flow",
      desktopLabel: <MethodologyLabel topic="netMintBurnFlow">Net Mint/Burn Flow</MethodologyLabel>,
      value: netFlow24Display,
      mobileMetaPrimary: <span className={netFlow7Class}>7d {netFlow7Display}</span>,
      desktopSublabel: <InfoChip label="7d net" value={netFlow7Display} tone={netFlow7Tone} />,
      mobileValueClassName: netFlow24Class,
      desktopValueClassName: netFlow24Class,
    },
  ];

  return (
    <>
    <Card aria-label="Market snapshot" className="pharos-card-shell overflow-hidden p-0">
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
            band={hasPsiData ? `${psiBandDisplay} · ${psiDaysInBand}d in band` : ""}
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

      <div className="hidden grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/30 lg:grid items-stretch">
        <div
          className="px-4 py-3"
          style={{
            animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
            animationDelay: `${delayFor("kpi", 0)}ms`,
          }}
        >
          <PrimarySnapshotCard
            value={psiScoreDisplay}
            band={hasPsiData ? `${psiBandDisplay} · ${psiDaysInBand}d in band` : ""}
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
    {lastUpdatedAt > 0 ? (
      <p className="mt-1 px-1 text-[11px] text-muted-foreground">
        Last refreshed · <RelativeAge timestamp={lastUpdatedAt} /> ·{" "}
        <time dateTime={new Date(lastUpdatedAt).toISOString()}>
          {formatDataHealthTimestamp(lastUpdatedAt)}
        </time>
      </p>
    ) : null}
    </>
  );
}

function RelativeAge({ timestamp }: { timestamp: number }) {
  // Tick once per minute so output changes at each minute boundary instead of
  // re-rendering twice per minute for identical text.
  const [, setTickMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const id = window.setInterval(() => {
      setTickMinute((prev) => {
        const next = Math.floor(Date.now() / 60_000);
        return next === prev ? prev : next;
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{timeAgo(Math.floor(timestamp / 1000))}</>;
}
