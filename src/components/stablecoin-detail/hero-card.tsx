"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
} from "@shared/lib/depeg-config";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-detection-config";
import { formatCurrency, formatSignedPercent } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import {
  THREAT_BAND_COLORS,
  THREAT_BAND_LABELS,
  THREAT_BAND_TEXT_COLORS,
  isThreatBand,
} from "@shared/lib/classification";
import type {
  DexLiquidityData,
  Infrastructure,
  PegSummaryCoin,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
  StressSignalEntry,
  VariantKind,
  YieldRanking,
} from "@shared/types";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { getVariantDisplay } from "@/lib/variant-display";
import {
  getYieldBenchmarkGapReferenceText,
  getYieldBenchmarkGapUnavailableText,
} from "@/lib/yield-benchmark";
import {
  HeroCardDesktopSection,
  HeroCardHeader,
  HeroCardMobileSection,
  type HeroSignalRailItem,
  type HeroTertiaryMetricConfig,
} from "./hero-card-sections";

interface HeroCardProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  isNavToken: boolean;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegScoreResult: PegSummaryCoin | null;
  recordedDepegEventCount: number | null;
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  reportCard: ReportCard | null;
  variantParent?: StablecoinMeta | null;
  variantKind?: VariantKind | null;
  onOpenFeedback: () => void;
}

export function HeroCard({
  coin,
  coinData,
  logoSrc,
  isNavToken,
  mcap,
  supply,
  prevDay,
  prevWeek,
  prevMonth,
  performanceVsUsd1y,
  pegRef,
  deviationBps,
  gaugeDeviationBps,
  pegScoreResult,
  recordedDepegEventCount,
  liquidityData,
  yieldRanking,
  stressSignal,
  reportCard,
  variantParent,
  variantKind,
  onOpenFeedback,
}: HeroCardProps) {
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const chainCount = coinData?.chains?.length ?? 0;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCard);
  const primaryComparisonPage = getPrimaryStaticComparisonPageForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);
  const benchmarkSymbol = primaryComparisonPage
    ? primaryComparisonPage.left.id === coin.id
      ? primaryComparisonPage.right.symbol
      : primaryComparisonPage.left.symbol
    : null;
  const hasPrevDay = typeof prevDay === "number" && prevDay > 0;
  const hasPrevWeek = typeof prevWeek === "number" && prevWeek > 0;
  const hasPrevMonth = typeof prevMonth === "number" && prevMonth > 0;
  const safePrevDay = hasPrevDay ? prevDay : null;
  const safePrevWeek = hasPrevWeek ? prevWeek : null;
  const safePrevMonth = hasPrevMonth ? prevMonth : null;
  const prevDayValue = safePrevDay ?? 0;
  const prevWeekValue = safePrevWeek ?? 0;
  const prevMonthValue = safePrevMonth ?? 0;
  const prevDayTrendClass = hasPrevDay
    ? mcap >= prevDayValue
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const prevWeekTrendClass = hasPrevWeek
    ? mcap >= prevWeekValue
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const prevMonthTrendClass = hasPrevMonth
    ? mcap >= prevMonthValue
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400"
    : "text-muted-foreground";

  const tooNewForPegScore =
    !isNavToken &&
    pegScoreResult !== null &&
    pegScoreResult.pegScore === null &&
    pegScoreResult.trackingSpanDays > 0 &&
    pegScoreResult.trackingSpanDays < 7;

  const earlyPegScore =
    !isNavToken &&
    pegScoreResult !== null &&
    pegScoreResult.pegScore !== null &&
    pegScoreResult.trackingSpanDays < 30;

  const pegScoreEventLine = (() => {
    if (!pegScoreResult) return null;
    const scoreWindowCount = pegScoreResult.eventCount;
    const totalRecorded = recordedDepegEventCount;
    if (totalRecorded == null || totalRecorded === scoreWindowCount) {
      return `${scoreWindowCount.toLocaleString()} event${scoreWindowCount !== 1 ? "s" : ""}`;
    }
    return `${totalRecorded.toLocaleString()} recorded · ${scoreWindowCount.toLocaleString()} in 4y window`;
  })();

  const pegScoreDisplay = !isNavToken
    ? pegScoreResult?.pegScore != null
      ? {
          value: pegScoreResult.pegScore,
          sub: pegScoreEventLine ?? `${pegScoreResult.pegPct.toFixed(1)}% at peg`,
          color: pegScoreColor(pegScoreResult.pegScore),
        }
      : tooNewForPegScore
        ? {
            value: "NR",
            sub: `${pegScoreResult?.trackingSpanDays ?? 0}d tracked`,
            color: "text-muted-foreground",
          }
        : { value: "—", sub: undefined, color: "text-muted-foreground" }
    : { value: "NAV", sub: "Token", color: "text-muted-foreground" };

  const liqDisplay = (() => {
    const liq = liquidityData;
    if (liq == null || (liq.liquidityScore === null && liq.poolCount === 0)) {
      return { value: "—", sub: undefined, color: "text-muted-foreground" };
    }
    const score = liq.liquidityScore ?? 0;
    return { value: Math.round(score), sub: `${liq.poolCount} pools`, color: getScoreColor(score) };
  })();

  const blacklistDisplay = (() => {
    switch (blacklistStatus) {
      case true:
        return {
          value: "Yes",
          sub: undefined,
          color: "text-red-700 dark:text-red-400",
        };
      case "possible":
        return {
          value: "Possible",
          sub: undefined,
          color: "text-amber-700 dark:text-amber-400",
        };
      case "inherited":
        return {
          value: "Upstream",
          sub: undefined,
          color: "text-amber-700 dark:text-amber-400",
        };
      default:
        return {
          value: "No",
          sub: undefined,
          color: "text-green-700 dark:text-green-400",
        };
    }
  })();

  const excessYieldDisplay = (() => {
    if (!yieldRanking) {
      return { value: "—", sub: undefined, color: "text-muted-foreground" };
    }
    if (yieldRanking.excessYield === null) {
      return {
        value: "—",
        sub: getYieldBenchmarkGapUnavailableText(),
        color: "text-muted-foreground",
      };
    }
    return {
      value: formatSignedPercent(yieldRanking.excessYield),
      sub: getYieldBenchmarkGapReferenceText(yieldRanking),
      color:
        yieldRanking.excessYield >= 0
          ? "text-green-700 dark:text-green-400"
          : "text-red-700 dark:text-red-400",
    };
  })();

  const performanceVsUsdDisplay = (() => {
    if (performanceVsUsd1y === null) return null;
    return {
      value: formatSignedPercent(performanceVsUsd1y),
      color:
        performanceVsUsd1y > 0
          ? "text-green-700 dark:text-green-400"
          : performanceVsUsd1y < 0
            ? "text-red-700 dark:text-red-400"
            : "text-muted-foreground",
    };
  })();

  const dewsDisplay: { value: React.ReactNode; sub?: string; color: string } = (() => {
    if (!stressSignal || !isThreatBand(stressSignal.band)) {
      return { value: "—", sub: undefined, color: "text-muted-foreground" };
    }
    return {
      value: (
        <Badge
          variant="outline"
          className={`px-2 py-0.5 text-xs font-semibold tracking-tight ${THREAT_BAND_COLORS[stressSignal.band]}`}
        >
          {THREAT_BAND_LABELS[stressSignal.band]}
        </Badge>
      ),
      sub: `${Math.round(stressSignal.score)}/100`,
      color: THREAT_BAND_TEXT_COLORS[stressSignal.band],
    };
  })();

  const pegScoreAccent = (() => {
    const score = pegScoreResult?.pegScore;
    if (score == null) return undefined;
    if (score < 50) return "border-l-2 border-l-red-500";
    if (score < 70) return "border-l-2 border-l-amber-500";
    return undefined;
  })();

  const liqAccent = (() => {
    const score = liquidityData?.liquidityScore;
    if (score == null) return undefined;
    if (score < 30) return "border-l-2 border-l-red-500";
    if (score < 50) return "border-l-2 border-l-amber-500";
    return undefined;
  })();

  const blacklistAccent = blacklistStatus === true ? "border-l-2 border-l-amber-500" : undefined;

  const dewsAccent = (() => {
    if (!stressSignal || !isThreatBand(stressSignal.band)) return undefined;
    if (stressSignal.band === "DANGER") return "border-l-2 border-l-red-500";
    if (stressSignal.band === "WARNING") return "border-l-2 border-l-orange-500";
    return undefined;
  })();

  const depegThresholdBps =
    coinData.pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
  const variantDisplay = variantKind ? getVariantDisplay(variantKind) : null;
  const limitedDepegCoverageNote =
    !isNavToken &&
    pegScoreResult?.depegEventCoverageLimited === true &&
    Math.abs(deviationBps) >= depegThresholdBps
      ? `Below ${formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live-event floor. Deviation is shown, but event history may stay empty.`
      : null;

  const tertiaryMetrics: HeroTertiaryMetricConfig[] = [
    {
      key: "dews",
      label: <MethodologyLabel topic="dewsBand">DEWS</MethodologyLabel>,
      value: dewsDisplay.value,
      subValue: dewsDisplay.sub,
      colorClass: dewsDisplay.color,
      accentClass: dewsAccent,
    },
    {
      key: "blacklistable",
      label: <MethodologyLabel topic="freezable">Freezable</MethodologyLabel>,
      value: blacklistDisplay.value,
      subValue: blacklistDisplay.sub,
      colorClass: blacklistDisplay.color,
      accentClass: blacklistAccent,
    },
    {
      key: "peg-score",
      label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>,
      mobileLabel: <MethodologyLabel topic="pegScore">Peg</MethodologyLabel>,
      value: pegScoreDisplay.value,
      subValue: pegScoreDisplay.sub,
      colorClass: pegScoreDisplay.color,
      accentClass: pegScoreAccent,
    },
    {
      key: "liquidity",
      label: <MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>,
      mobileLabel: <MethodologyLabel topic="liquidityScore">Liq</MethodologyLabel>,
      value: liqDisplay.value,
      subValue: liqDisplay.sub,
      colorClass: liqDisplay.color,
      accentClass: liqAccent,
    },
    {
      key: "excess-yield",
      label: <MethodologyLabel topic="pys">30d Excess</MethodologyLabel>,
      value: excessYieldDisplay.value,
      subValue: excessYieldDisplay.sub,
      colorClass: excessYieldDisplay.color,
    },
    ...(performanceVsUsdDisplay
      ? [
          {
            key: "performance-vs-usd",
            label: "1Y vs USD",
            value: performanceVsUsdDisplay.value,
            colorClass: performanceVsUsdDisplay.color,
          },
        ]
      : []),
  ];

  const signalRailItems: HeroSignalRailItem[] = [
    {
      key: "safety",
      label: "Safety",
      primary: reportCard?.overallGrade ?? "—",
      secondary: reportCard?.overallScore != null ? `${reportCard.overallScore}/100` : null,
      href: "#report-card",
      colorClass: reportCard?.overallGrade
        ? REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]
        : "text-muted-foreground",
    },
    {
      key: "peg",
      label: "Peg",
      primary:
        !isNavToken && pegScoreResult?.pegScore != null
          ? String(pegScoreResult.pegScore)
          : isNavToken
            ? "NAV"
            : "—",
      secondary: null,
      href: "#report-card",
      colorClass:
        !isNavToken && pegScoreResult?.pegScore != null
          ? pegScoreColor(pegScoreResult.pegScore)
          : "text-muted-foreground",
    },
    {
      key: "liquidity",
      label: "Liquidity",
      primary:
        liquidityData?.liquidityScore != null
          ? String(Math.round(liquidityData.liquidityScore))
          : "—",
      secondary: liquidityData?.poolCount != null ? `${liquidityData.poolCount} pools` : null,
      href: "#liquidity",
      colorClass:
        liquidityData?.liquidityScore != null
          ? getScoreColor(liquidityData.liquidityScore)
          : "text-muted-foreground",
    },
    {
      key: "dews",
      label: "DEWS",
      primary:
        stressSignal && isThreatBand(stressSignal.band)
          ? THREAT_BAND_LABELS[stressSignal.band]
          : "—",
      secondary: stressSignal?.score != null ? `${Math.round(stressSignal.score)}/100` : null,
      href: "#report-card",
      colorClass:
        stressSignal && isThreatBand(stressSignal.band)
          ? THREAT_BAND_TEXT_COLORS[stressSignal.band]
          : "text-muted-foreground",
    },
  ];

  return (
    <Card className="rounded-xl gap-0">
      <HeroCardHeader
        coinId={coin.id}
        coinName={coin.name}
        compareHref={compareHref}
        benchmarkSymbol={benchmarkSymbol}
        onOpenFeedback={onOpenFeedback}
      />
      <HeroCardMobileSection
        coin={coin}
        coinData={coinData}
        logoSrc={logoSrc}
        reportCard={reportCard}
        variantParent={variantParent}
        variantChipClass={variantDisplay?.chipClass ?? null}
        infrastructures={infrastructures}
        pegRef={pegRef}
        gaugeDeviationBps={gaugeDeviationBps}
        deviationBps={deviationBps}
        isNavToken={isNavToken}
        limitedDepegCoverageNote={limitedDepegCoverageNote}
        mcap={mcap}
        supply={supply}
        safePrevDay={safePrevDay}
        prevDayTrendClass={prevDayTrendClass}
        safePrevWeek={safePrevWeek}
        prevWeekTrendClass={prevWeekTrendClass}
        hasPrevMonth={hasPrevMonth}
        safePrevMonth={safePrevMonth}
        prevMonthTrendClass={prevMonthTrendClass}
        tertiaryMetrics={tertiaryMetrics}
        chainCount={chainCount}
        earlyPegScore={earlyPegScore}
        trackingSpanDays={pegScoreResult?.trackingSpanDays ?? 0}
        activeDepeg={pegScoreResult?.activeDepeg === true}
      />
      <HeroCardDesktopSection
        coin={coin}
        coinData={coinData}
        logoSrc={logoSrc}
        variantParent={variantParent}
        variantChipClass={variantDisplay?.chipClass ?? null}
        infrastructures={infrastructures}
        pegRef={pegRef}
        gaugeDeviationBps={gaugeDeviationBps}
        deviationBps={deviationBps}
        isNavToken={isNavToken}
        limitedDepegCoverageNote={limitedDepegCoverageNote}
        mcap={mcap}
        supply={supply}
        safePrevDay={safePrevDay}
        prevDayTrendClass={prevDayTrendClass}
        safePrevWeek={safePrevWeek}
        prevWeekTrendClass={prevWeekTrendClass}
        hasPrevMonth={hasPrevMonth}
        safePrevMonth={safePrevMonth}
        prevMonthTrendClass={prevMonthTrendClass}
        signalRailItems={signalRailItems}
        tertiaryMetrics={tertiaryMetrics.filter(
          (metric) => metric.key !== "dews" && metric.key !== "liquidity",
        )}
        chainCount={chainCount}
        earlyPegScore={earlyPegScore}
        trackingSpanDays={pegScoreResult?.trackingSpanDays ?? 0}
        activeDepeg={pegScoreResult?.activeDepeg === true}
      />
    </Card>
  );
}
