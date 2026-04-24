"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDataHealthTimestamp } from "@/lib/data-health";
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
import {
  InfoChip,
  KpiCell,
  KpiMiniTile,
  KpiSkeleton,
  PrimarySnapshotCard,
  TrendChip,
  trendDirection,
  trendTextClass,
  type KpiMetricDefinition,
} from "@/components/kpi-bar-parts";
import { MethodologyLabel } from "@/components/methodology-hint";

const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);

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
  // Uses the project's mandated text-*-700 dark:text-*-400 pairing per
  // docs/design-tokens.md so the pill passes AA contrast in both themes.
  const dewsSeverityClass = !dewsBandCounts
    ? "text-muted-foreground"
    : dewsBandCounts.danger > 0
      ? "text-red-700 dark:text-red-400"
      : dewsBandCounts.warning > 0
        ? "text-orange-700 dark:text-orange-400"
        : dewsBandCounts.alert > 0
          ? "text-yellow-700 dark:text-yellow-400"
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
