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
  THREAT_BAND_LABELS,
  isThreatBand,
} from "@shared/lib/classification";
import { getProtocolFamilyLabel } from "@shared/lib/protocol-family";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSignedPercent,
  formatSupply,
} from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { isBlacklistable } from "@shared/lib/report-cards";
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

// Compact metric chip for tertiary metrics
function MetricChip({
  label,
  value,
  subValue,
  colorClass = "text-foreground",
}: {
  label: React.ReactNode;
  value: string | number;
  subValue?: string;
  colorClass?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-base font-bold font-mono ${colorClass}`}>{value}</span>
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

function ProtocolFamilyTag({ label }: { label: string | null }) {
  if (!label) return null;

  return (
    <span className="inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-frost-blue">
      {label}
    </span>
  );
}

function LiquityForkBadge({ variant }: { variant?: "v1" | "v2" }) {
  if (!variant) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Liquity Fork</span>
      <span className="text-base font-bold font-mono text-frost-blue">{variant}</span>
    </div>
  );
}

function HeroClassificationLine({ coin }: { coin: StablecoinMeta }) {
  return (
    <p className="text-xs text-muted-foreground">
      {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
      {" · "}
      {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
      {" · "}
      {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
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
  const protocolLabel = getProtocolFamilyLabel(coin);
  const chainCount = coinData?.chains?.length ?? 0;
  const blacklistStatus = reportCard?.rawInputs.canBeBlacklisted ?? isBlacklistable(coin);
  const primaryComparisonPage = getPrimaryStaticComparisonPageForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);
  const benchmarkSymbol = primaryComparisonPage
    ? primaryComparisonPage.left.id === coin.id
      ? primaryComparisonPage.right.symbol
      : primaryComparisonPage.left.symbol
    : null;
  const liquityForkVariant =
    coin.protocolFamily === "liquity" && (coin.protocolVariant === "v1" || coin.protocolVariant === "v2")
      ? coin.protocolVariant
      : undefined;
  const hasPrevDay = typeof prevDay === "number" && prevDay > 0;
  const hasPrevWeek = typeof prevWeek === "number" && prevWeek > 0;
  const hasPrevMonth = typeof prevMonth === "number" && prevMonth > 0;
  const prevDayTrendClass = hasPrevDay
    ? mcap >= prevDay
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const prevWeekTrendClass = hasPrevWeek
    ? mcap >= prevWeek
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const prevMonthTrendClass = hasPrevMonth
    ? mcap >= prevMonth
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
      case "possible-inherited":
        return {
          value: "Possible",
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
  const dewsDisplay = (() => {
    if (!stressSignal || !isThreatBand(stressSignal.band)) {
      return { value: "—", sub: undefined, color: "text-muted-foreground" };
    }
    return {
      value: THREAT_BAND_LABELS[stressSignal.band],
      sub: `${Math.round(stressSignal.score)}/100`,
      color: THREAT_BAND_TEXT_COLORS[stressSignal.band],
    };
  })();

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
              <ProtocolFamilyTag label={protocolLabel} />
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
          </div>

          {/* Market Cap */}
          <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</p>
            <p className="text-lg font-bold font-mono tracking-tight">{formatCurrency(mcap)}</p>
            <p className={`text-xs font-mono mt-1 ${prevDayTrendClass}`}>
              {hasPrevDay ? formatPercentChange(mcap, prevDay!) : "—"} <span className="text-muted-foreground">24h</span>
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
                {hasPrevWeek ? formatPercentChange(mcap, prevWeek!) : "—"} <span className="text-muted-foreground">7d</span>
              </p>
              {hasPrevMonth && (
                <p className={`text-xs font-mono ${prevMonthTrendClass}`}>
                  {formatPercentChange(mcap, prevMonth!)} <span className="text-muted-foreground">30d</span>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Tertiary Metrics */}
        <div className="mt-3 flex flex-wrap gap-2">
          <MetricChip
            label={<MethodologyLabel topic="pegScore">Peg</MethodologyLabel>}
            value={pegScoreDisplay.value}
            subValue={pegScoreDisplay.sub}
            colorClass={pegScoreDisplay.color}
          />
          <MetricChip
            label={<MethodologyLabel topic="liquidityScore">Liq</MethodologyLabel>}
            value={liqDisplay.value}
            subValue={liqDisplay.sub}
            colorClass={liqDisplay.color}
          />
          <MetricChip
            label="Blacklistable"
            value={blacklistDisplay.value}
            subValue={blacklistDisplay.sub}
            colorClass={blacklistDisplay.color}
          />
          <MetricChip
            label={<MethodologyLabel topic="pys">Excess Yield</MethodologyLabel>}
            value={excessYieldDisplay.value}
            subValue={excessYieldDisplay.sub}
            colorClass={excessYieldDisplay.color}
          />
          {performanceVsUsdDisplay && (
            <MetricChip
              label="1Y vs USD"
              value={performanceVsUsdDisplay.value}
              colorClass={performanceVsUsdDisplay.color}
            />
          )}
          <MetricChip
            label={<MethodologyLabel topic="dews">DEWS</MethodologyLabel>}
            value={dewsDisplay.value}
            subValue={dewsDisplay.sub}
            colorClass={dewsDisplay.color}
          />
          <div className="flex items-center gap-1 rounded-lg border border-border/40 bg-background/30 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">{chainCount} chains</span>
          </div>
          <LiquityForkBadge variant={liquityForkVariant} />
        </div>

        {pegScoreResult?.activeDepeg && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            Active depeg detected
          </div>
        )}
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
                    <ProtocolFamilyTag label={protocolLabel} />
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
                    </div>
                  </div>
                </div>

                {/* Market Cap */}
                <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</p>
                  <p className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(mcap)}</p>
                  <p className={`text-xs font-mono mt-1 ${prevDayTrendClass}`}>
                    {hasPrevDay ? formatPercentChange(mcap, prevDay!) : "—"} <span className="text-muted-foreground">24h</span>
                  </p>
                </div>

                {/* Supply */}
                <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Supply</p>
                  <p className="text-2xl font-bold font-mono tracking-tight">
                    {supply != null ? formatSupply(supply) : "—"} <span className="text-sm text-muted-foreground">{coin.symbol}</span>
                  </p>
                  <p className="text-xs font-mono mt-1 whitespace-nowrap">
                    <span className={prevWeekTrendClass}>{hasPrevWeek ? formatPercentChange(mcap, prevWeek!) : "—"}</span>
                    <span className="text-muted-foreground"> 7d</span>
                    {hasPrevMonth && (
                      <>
                        <span className="text-muted-foreground"> · </span>
                        <span className={prevMonthTrendClass}>{formatPercentChange(mcap, prevMonth!)}</span>
                        <span className="text-muted-foreground"> 30d</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Right Column - Safety Grade */}
            <div className="w-52 shrink-0">
              <SafetyGradeHero reportCard={reportCard} />
            </div>
          </div>

          {/* Tertiary Metrics */}
          <div className="flex flex-wrap items-center gap-3">
            <MetricChip
              label={<MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>}
              value={pegScoreDisplay.value}
              subValue={pegScoreDisplay.sub}
              colorClass={pegScoreDisplay.color}
            />
            <MetricChip
              label={<MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>}
              value={liqDisplay.value}
              subValue={liqDisplay.sub}
              colorClass={liqDisplay.color}
            />
            <MetricChip
              label="Blacklistable"
              value={blacklistDisplay.value}
              subValue={blacklistDisplay.sub}
              colorClass={blacklistDisplay.color}
            />
            <MetricChip
              label={<MethodologyLabel topic="pys">Excess Yield</MethodologyLabel>}
              value={excessYieldDisplay.value}
              subValue={excessYieldDisplay.sub}
              colorClass={excessYieldDisplay.color}
            />
            {performanceVsUsdDisplay && (
              <MetricChip
                label="1Y vs USD"
                value={performanceVsUsdDisplay.value}
                colorClass={performanceVsUsdDisplay.color}
              />
            )}
            <MetricChip
              label={<MethodologyLabel topic="dews">DEWS</MethodologyLabel>}
              value={dewsDisplay.value}
              subValue={dewsDisplay.sub}
              colorClass={dewsDisplay.color}
            />
            <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/30 px-3 py-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Chains</span>
              <span className="text-base font-bold font-mono">{chainCount}</span>
            </div>
            <LiquityForkBadge variant={liquityForkVariant} />
            {earlyPegScore && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Early peg score · {pegScoreResult?.trackingSpanDays ?? 0}d tracked
              </span>
            )}
          </div>

          {pegScoreResult?.activeDepeg && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-700 dark:text-red-400">
              Active depeg detected — view details in Depeg History
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
