"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { PegGauge } from "@/components/peg-gauge";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card } from "@/components/ui/card";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
  THREAT_BAND_COLORS,
  THREAT_BAND_LABELS,
  isThreatBand,
} from "@shared/lib/classification";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { Infrastructure } from "@shared/types";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
import { PEG_SLUGS } from "@/lib/peg-landing";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSignedPercent,
  formatSupply,
} from "@shared/lib/format";
import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
} from "@shared/lib/depeg-config";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-detection-config";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type {
  DexLiquidityData,
  PegSummaryCoin,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";

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
  onOpenFeedback: () => void;
}

// Compact metric chip for tertiary metrics. Empty state value is the em dash
// "—"; we mark it with aria-label so screen readers announce missing data
// instead of literally reading the glyph.
function MetricChip({
  label,
  value,
  subValue,
  colorClass = "text-foreground",
  accentClass,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
}) {
  const isEmpty = value === "—";
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 ${accentClass ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className={`text-base font-bold font-mono ${colorClass}`}
        aria-label={isEmpty ? "Data unavailable" : undefined}
      >
        {value}
      </span>
      {subValue && <span className="text-xs text-muted-foreground">{subValue}</span>}
    </div>
  );
}

function HeroTagList({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground border-border/60 bg-muted/40"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function InfrastructureBadge({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const colorClass = isM0
    ? "text-violet-700 dark:text-violet-400"
    : "text-frost-blue";
  const borderClass = isM0
    ? "border-violet-500/30 bg-violet-500/10"
    : "border-frost-blue/30 bg-frost-blue/10";

  return (
    <div className={`flex items-center gap-2 rounded-lg border ${borderClass} px-2.5 py-1.5`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Infrastructure</span>
      <span className={`text-base font-bold font-mono ${colorClass}`}>{label}</span>
    </div>
  );
}

function InfrastructureChip({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const className = isM0
    ? "inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-400"
    : "inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-frost-blue";
  return <span className={className}>{label}</span>;
}

interface TertiaryMetricConfig {
  key: string;
  label: React.ReactNode;
  mobileLabel?: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  /** Optional border-l accent class for risk-flagged chips (e.g. "border-l-2 border-l-red-500") */
  accentClass?: string;
}

function HeroTertiaryMetrics({
  metrics,
  chainCount,
  infrastructures,
  earlyPegScore,
  trackingSpanDays,
  activeDepeg,
  mobile = false,
}: {
  metrics: TertiaryMetricConfig[];
  chainCount: number;
  infrastructures: Infrastructure[];
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
  mobile?: boolean;
}) {
  return (
    <>
      <div className={mobile ? "mt-3 flex flex-wrap gap-2" : "flex flex-wrap items-center gap-3"}>
        {metrics.map((metric) => (
          <MetricChip
            key={metric.key}
            label={mobile ? (metric.mobileLabel ?? metric.label) : metric.label}
            value={metric.value}
            subValue={metric.subValue}
            colorClass={metric.colorClass}
            accentClass={metric.accentClass}
          />
        ))}
        {mobile ? (
          <div className="flex items-center gap-1 rounded-lg border border-border/40 bg-background/30 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">{chainCount} chains</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/30 px-3 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Chains</span>
            <span className="text-base font-bold font-mono">{chainCount}</span>
          </div>
        )}
        {infrastructures.map((value) => (
          <InfrastructureBadge key={value} value={value} />
        ))}
        {!mobile && earlyPegScore && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Early peg score · {trackingSpanDays}d tracked
          </span>
        )}
      </div>

      {activeDepeg && (
        <div
          className={mobile
            ? "mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-400"
            : "rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-700 dark:text-red-400"}
        >
          {mobile ? "Active depeg detected" : "Active depeg detected — view details in Depeg History"}
        </div>
      )}
    </>
  );
}

function HeroClassificationLine({ coin }: { coin: StablecoinMeta }) {
  const pegSlug = PEG_SLUGS[coin.flags.pegCurrency];
  const pegHref = pegSlug ? `/stablecoins/${pegSlug}/` : null;
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";

  return (
    <p className="flex flex-wrap items-center gap-1.5">
      <Link href={governanceHref} className={pillClass}>
        {governanceLabel}
      </Link>
      <Link href={backingHref} className={pillClass}>
        {backingLabel}
      </Link>
      {pegHref ? (
        <Link href={pegHref} className={pillClass}>
          {pegLabel}
        </Link>
      ) : (
        <span className={pillClass}>{pegLabel}</span>
      )}
    </p>
  );
}

const THREAT_BAND_TEXT_COLORS = {
  CALM: "text-green-700 dark:text-green-400",
  WATCH: "text-teal-700 dark:text-teal-400",
  ALERT: "text-yellow-700 dark:text-yellow-400",
  WARNING: "text-orange-700 dark:text-orange-400",
  DANGER: "text-red-700 dark:text-red-400",
} as const;

function HeroSignalsRail({
  reportCard,
  pegScoreResult,
  liquidityData,
  stressSignal,
  isNavToken,
}: {
  reportCard: ReportCard | null;
  pegScoreResult: PegSummaryCoin | null;
  liquidityData: DexLiquidityData | undefined;
  stressSignal: StressSignalEntry | null;
  isNavToken: boolean;
}) {
  const safetyGrade = reportCard?.overallGrade ?? "—";
  const safetyScore = reportCard?.overallScore ?? null;
  const pegScore = !isNavToken ? pegScoreResult?.pegScore ?? null : null;
  const liquidityScore = liquidityData?.liquidityScore ?? null;
  const dewsBand = stressSignal && isThreatBand(stressSignal.band) ? THREAT_BAND_LABELS[stressSignal.band] : null;
  const dewsScore = stressSignal?.score ?? null;

  const items: Array<{
    key: string;
    label: string;
    primary: string;
    secondary: string | null;
    href: string;
    colorClass: string;
  }> = [
    {
      key: "safety",
      label: "Safety",
      primary: safetyGrade,
      secondary: safetyScore != null ? `${safetyScore}/100` : null,
      href: "#report-card",
      colorClass: reportCard?.overallGrade ? REPORT_CARD_GRADE_COLORS[reportCard.overallGrade] : "text-muted-foreground",
    },
    {
      key: "peg",
      label: "Peg",
      primary: pegScore != null ? String(pegScore) : isNavToken ? "NAV" : "—",
      secondary: null,
      href: "#report-card",
      colorClass: pegScore != null ? pegScoreColor(pegScore) : "text-muted-foreground",
    },
    {
      key: "liquidity",
      label: "Liquidity",
      primary: liquidityScore != null ? String(Math.round(liquidityScore)) : "—",
      secondary: liquidityData?.poolCount != null ? `${liquidityData.poolCount} pools` : null,
      href: "#liquidity",
      colorClass: liquidityScore != null ? getScoreColor(liquidityScore) : "text-muted-foreground",
    },
    {
      key: "dews",
      label: "DEWS",
      primary: dewsBand ?? "—",
      secondary: dewsScore != null ? `${Math.round(dewsScore)}/100` : null,
      href: "#report-card",
      colorClass: "text-foreground",
    },
  ];

  return (
    <nav aria-label="Hero signals" className="flex flex-col gap-1.5">
      {items.map((item, idx) => (
        <Link
          key={item.key}
          href={item.href}
          className={`pharos-focus-ring group flex items-baseline justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2 transition-colors hover:border-border hover:bg-background/70 ${
            idx === 0 ? "py-2.5" : ""
          }`}
        >
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {item.label}
          </span>
          <span className="flex items-baseline gap-1.5">
            <span
              className={`font-mono tabular-nums ${idx === 0 ? "text-base font-extrabold" : "text-sm font-semibold"} ${item.colorClass}`}
            >
              {item.primary}
            </span>
            {item.secondary ? (
              <span className="font-mono text-[10px] text-muted-foreground">{item.secondary}</span>
            ) : null}
          </span>
        </Link>
      ))}
    </nav>
  );
}

function SafetyGradeHero({
  reportCard,
  mobile = false,
}: {
  reportCard: ReportCard | null;
  mobile?: boolean;
}) {
  if (!reportCard || reportCard.isDefunct) {
    return (
      <div className={`flex flex-col items-center justify-center rounded-xl border border-border/60 bg-background/50 ${mobile ? "px-3 py-2" : "px-4 py-3"}`}>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Safety</span>
        <span className="text-lg font-bold text-muted-foreground">—</span>
      </div>
    );
  }

  const sizeClasses = mobile
    ? "text-3xl px-3 py-1.5"
    : "text-5xl px-6 py-3";

  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border-2 border-border/60 bg-background/50 ${mobile ? "px-3 py-2 gap-1" : "px-5 py-4 gap-2.5"}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Safety Grade</span>
      <Badge
        variant="outline"
        className={`${sizeClasses} font-extrabold tracking-tight ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
      >
        {reportCard.overallGrade}
      </Badge>
      {reportCard.overallScore !== null && (
        <span className={`font-mono tabular-nums tracking-tight text-foreground ${mobile ? "text-sm" : "text-lg"}`}>
          {reportCard.overallScore}<span className="text-xs text-muted-foreground">/100</span>
        </span>
      )}
    </div>
  );
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
      ? { value: pegScoreResult.pegScore, sub: pegScoreEventLine ?? `${pegScoreResult.pegPct.toFixed(1)}% at peg`, color: pegScoreColor(pegScoreResult.pegScore) }
      : tooNewForPegScore
        ? { value: "NR", sub: `${pegScoreResult?.trackingSpanDays ?? 0}d tracked`, color: "text-muted-foreground" }
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
      return { value: "—", sub: "No benchmark gap", color: "text-muted-foreground" };
    }
    return {
      value: formatSignedPercent(yieldRanking.excessYield),
      sub: "vs Ref",
      color: yieldRanking.excessYield >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400",
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
  const dewsDisplay: { value: React.ReactNode; sub: string | undefined; color: string } = (() => {
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
  // Compute border-left accent classes for risk-flagged chips
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
  const depegThresholdBps = coinData.pegType === "peggedUSD"
    ? DEPEG_THRESHOLD_BPS
    : DEPEG_THRESHOLD_BPS_NON_USD;
  const limitedDepegCoverageNote =
    !isNavToken &&
    pegScoreResult?.depegEventCoverageLimited === true &&
    Math.abs(deviationBps) >= depegThresholdBps
      ? `Below ${formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live-event floor. Deviation is shown, but event history may stay empty.`
      : null;

  // Severity-ordered: forward-looking stress signals first (DEWS, Freezable),
  // then performance metrics (Peg, Liquidity), then yield context, then the
  // rare performance-vs-USD chip. The CHAINS count stays in the dedicated
  // trailing slot rendered by HeroTertiaryMetrics.
  const tertiaryMetrics: TertiaryMetricConfig[] = [
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
      label: <MethodologyLabel topic="pys">Excess Yield</MethodologyLabel>,
      value: excessYieldDisplay.value,
      subValue: excessYieldDisplay.sub,
      colorClass: excessYieldDisplay.color,
    },
    ...(performanceVsUsdDisplay
      ? [{
          key: "performance-vs-usd",
          label: "1Y vs USD",
          value: performanceVsUsdDisplay.value,
          colorClass: performanceVsUsdDisplay.color,
        }]
      : []),
  ];

  return (
    <Card className="rounded-xl gap-0">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 pt-3 pb-2.5 border-b border-border/30">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="pharos-focus-ring rounded-sm transition-colors hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground" aria-current="page">
            {coin.name}
          </span>
        </nav>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenFeedback}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground lg:min-h-9 lg:rounded-md lg:px-2 lg:py-1"
          >
            <Flag className="h-3 w-3" />
            <span className="hidden sm:inline">Report issue</span>
          </button>
          <Link
            href={compareHref}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground lg:min-h-9 lg:rounded-md lg:px-2 lg:py-1"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            {benchmarkSymbol ? `Compare vs ${benchmarkSymbol}` : "Compare"}
          </Link>
          <ShareButton ogPath={`/api/og/stablecoin/${coin.id}`} label="Share" />
        </div>
      </div>

      {/* Mobile Layout */}
      <div className="px-4 sm:px-5 py-4 lg:hidden">
        <div className="flex items-start gap-3">
          <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-black tracking-tighter">{coin.name}</h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
              <span className="text-sm font-mono text-muted-foreground">{coin.symbol}</span>
              <BluechipHeaderBadge stablecoinId={coin.id} />
            </div>
            <HeroClassificationLine coin={coin} />
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {infrastructures.map((value) => (
                <InfrastructureChip key={value} value={value} />
              ))}
              <HeroTagList tags={coin.tags} />
            </div>
          </div>
          <SafetyGradeHero reportCard={reportCard} mobile />
        </div>

        {/* Primary Metrics */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          {/* Price */}
          <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
            <div className="flex items-center gap-2">
              {coinData.price != null && pegRef > 0 && (
                <PegGauge deviationBps={gaugeDeviationBps} className="w-12" />
              )}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Price</p>
                <p className={`text-xl font-extrabold font-mono tracking-tight ${confidenceClass(coinData.priceConfidence)}`}>
                  {formatNativePrice(
                    coinData.price != null ? Math.floor(coinData.price * 1000) / 1000 : coinData.price,
                    coin.flags.pegCurrency ?? "USD",
                    pegRef,
                    3,
                  )}
                </p>
              </div>
            </div>
            <p className={`text-xs font-mono mt-1 ${isNavToken ? "text-green-700 dark:text-green-400" : deviationColorClass(Math.abs(deviationBps))}`}>
              {formatPegDeviation(coinData.price, pegRef)}
            </p>
            {limitedDepegCoverageNote ? (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                {limitedDepegCoverageNote}
              </p>
            ) : null}
          </div>

          {/* Market Cap */}
          <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</p>
            <p className="text-lg font-bold font-mono tracking-tight">{formatCurrency(mcap)}</p>
            <p className={`text-xs font-mono mt-1 ${prevDayTrendClass}`}>
              {safePrevDay == null ? "—" : formatPercentChange(mcap, safePrevDay)} <span className="text-muted-foreground">24h</span>
            </p>
          </div>
        </div>

        {/* Secondary Metrics */}
        <div className="mt-3 rounded-lg border border-border/40 bg-background/30 px-3 py-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Supply</p>
              <p className="text-base font-bold font-mono">
                {supply != null ? formatSupply(supply) : "—"} <span className="text-xs text-muted-foreground">{coin.symbol}</span>
              </p>
            </div>
            <div className="text-right">
              <p className={`text-xs font-mono ${prevWeekTrendClass}`}>
                {safePrevWeek == null ? "—" : formatPercentChange(mcap, safePrevWeek)} <span className="text-muted-foreground">7d</span>
              </p>
              {hasPrevMonth && (
                <p className={`text-xs font-mono ${prevMonthTrendClass}`}>
                  {safePrevMonth == null ? "—" : formatPercentChange(mcap, safePrevMonth)} <span className="text-muted-foreground">30d</span>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Tertiary Metrics */}
        <HeroTertiaryMetrics
          metrics={tertiaryMetrics}
          chainCount={chainCount}
          infrastructures={infrastructures}
          earlyPegScore={earlyPegScore}
          trackingSpanDays={pegScoreResult?.trackingSpanDays ?? 0}
          activeDepeg={pegScoreResult?.activeDepeg === true}
          mobile
        />
      </div>

      {/* Desktop Layout */}
      <div className="hidden lg:block px-5 py-5">
        <div className="space-y-4">
          <div className="flex gap-6">
            {/* Left Column - Identity & Metrics */}
            <div className="flex-1 min-w-0">
              {/* Identity */}
              <div className="flex items-start gap-3">
                <StablecoinLogo src={logoSrc} name={coin.name} size={64} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-3xl font-black tracking-tighter">{coin.name}</h2>
                    <span className="text-base font-mono text-muted-foreground/70">{coin.symbol}</span>
                    <BluechipHeaderBadge stablecoinId={coin.id} />
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <HeroClassificationLine coin={coin} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {infrastructures.map((value) => (
                      <InfrastructureChip key={value} value={value} />
                    ))}
                    <HeroTagList tags={coin.tags} />
                  </div>
                </div>
              </div>

              {/* Primary Metrics Row */}
              <div className="mt-5 grid grid-cols-3 gap-4">
                {/* Price */}
                <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
                  <div className="flex items-center gap-3">
                    {coinData.price != null && pegRef > 0 && (
                      <PegGauge deviationBps={gaugeDeviationBps} className="w-16 xl:w-20" />
                    )}
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Price</p>
                      <p className={`text-2xl xl:text-3xl font-extrabold font-mono tracking-tight ${confidenceClass(coinData.priceConfidence)}`}>
                        {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef)}
                      </p>
                      <p className={`text-xs font-mono mt-0.5 ${isNavToken ? "text-green-700 dark:text-green-400" : deviationColorClass(Math.abs(deviationBps))}`}>
                        {formatPegDeviation(coinData.price, pegRef)}
                      </p>
                      {limitedDepegCoverageNote ? (
                        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                          {limitedDepegCoverageNote}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* Market Cap */}
                <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</p>
                  <p className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(mcap)}</p>
                  <p className={`text-xs font-mono mt-1 ${prevDayTrendClass}`}>
                    {safePrevDay == null ? "—" : formatPercentChange(mcap, safePrevDay)} <span className="text-muted-foreground">24h</span>
                  </p>
                </div>

                {/* Supply */}
                <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Supply</p>
                  <p className="text-2xl font-bold font-mono tracking-tight">
                    {supply != null ? formatSupply(supply) : "—"} <span className="text-sm text-muted-foreground">{coin.symbol}</span>
                  </p>
                  <p className="text-xs font-mono mt-1 whitespace-nowrap">
                    <span className={prevWeekTrendClass}>{safePrevWeek == null ? "—" : formatPercentChange(mcap, safePrevWeek)}</span>
                    <span className="text-muted-foreground"> 7d</span>
                    {hasPrevMonth && (
                      <>
                        <span className="text-muted-foreground"> · </span>
                        <span className={prevMonthTrendClass}>{safePrevMonth == null ? "—" : formatPercentChange(mcap, safePrevMonth)}</span>
                        <span className="text-muted-foreground"> 30d</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Right Column - Hero Signals Rail
                Replaces the former SafetyGradeHero duplicate: the Safety Score
                card lives below under #report-card. Mobile still surfaces the
                grade via SafetyGradeHero since the card is far down scroll. */}
            <div className="w-56 shrink-0">
              <HeroSignalsRail
                reportCard={reportCard}
                pegScoreResult={pegScoreResult}
                liquidityData={liquidityData}
                stressSignal={stressSignal}
                isNavToken={isNavToken}
              />
            </div>
          </div>

          {/* Tertiary Metrics */}
          <HeroTertiaryMetrics
            metrics={tertiaryMetrics}
            chainCount={chainCount}
            infrastructures={infrastructures}
            earlyPegScore={earlyPegScore}
            trackingSpanDays={pegScoreResult?.trackingSpanDays ?? 0}
            activeDepeg={pegScoreResult?.activeDepeg === true}
          />
        </div>
      </div>
    </Card>
  );
}
