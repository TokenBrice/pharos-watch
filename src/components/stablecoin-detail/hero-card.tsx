"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { PegGauge } from "@/components/peg-gauge";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card } from "@/components/ui/card";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
} from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityData, PegSummaryCoin, ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";
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
  prev90d: number;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  usesFallbackPegRate: boolean;
  pegScoreResult: PegSummaryCoin | null;
  recordedDepegEventCount: number | null;
  pegScoreBorderClass: string;
  liquidityData: DexLiquidityData | undefined;
  liqBorderClass: string;
  reportCard: ReportCard | null;
  onOpenFeedback: () => void;
}

function HeroMetricCard({
  label,
  className = "",
  children,
}: {
  label: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-border/60 bg-background/45 px-3.5 py-3 ${className}`}>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
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
          className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground border-border/60 bg-muted/40"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function HeroClassificationLine({ coin }: { coin: StablecoinMeta }) {
  return (
    <p className="text-sm text-muted-foreground/70">
      {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
      {" \u00b7 "}
      {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
      {" \u00b7 "}
      {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
    </p>
  );
}

function HeroIdentityHeader({
  coin,
  logoSrc,
  mobile,
}: {
  coin: StablecoinMeta;
  logoSrc?: string;
  mobile: boolean;
}) {
  if (mobile) {
    return (
      <div className="flex items-start gap-3">
        <StablecoinLogo src={logoSrc} name={coin.name} size={44} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 text-xl font-extrabold tracking-tighter">{coin.name}</h2>
            <span className="text-sm font-mono text-muted-foreground">{coin.symbol}</span>
            <BluechipHeaderBadge stablecoinId={coin.id} />
          </div>
          <HeroClassificationLine coin={coin} />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <StablecoinLogo src={logoSrc} name={coin.name} size={56} />
        <h2 className="text-3xl font-extrabold tracking-tighter">{coin.name}</h2>
        <span className="text-lg text-muted-foreground/70 font-mono">{coin.symbol}</span>
        <BluechipHeaderBadge stablecoinId={coin.id} />
      </div>
      <HeroClassificationLine coin={coin} />
    </>
  );
}

function HeroPriceContent({
  coin,
  coinData,
  pegRef,
  gaugeDeviationBps,
  isNavToken,
  deviationBps,
  usesFallbackPegRate,
  gaugeClassName,
}: {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  pegRef: number;
  gaugeDeviationBps: number;
  isNavToken: boolean;
  deviationBps: number;
  usesFallbackPegRate: boolean;
  gaugeClassName: string;
}) {
  return (
    <>
      {coinData.price != null && pegRef > 0 && (
        <PegGauge deviationBps={gaugeDeviationBps} className={gaugeClassName} />
      )}
      <div className="min-w-0">
        <div className="text-3xl font-extrabold font-mono tracking-tight">
          <span className={`sm:hidden ${confidenceClass(coinData.priceConfidence)}`}>
            {formatNativePrice(
              coinData.price != null ? Math.floor(coinData.price * 1000) / 1000 : coinData.price,
              coin.flags.pegCurrency ?? "USD",
              pegRef,
              3,
            )}
          </span>
          <span className={`hidden sm:inline ${confidenceClass(coinData.priceConfidence)}`}>
            {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef)}
          </span>
        </div>
        <p
          className={`text-sm font-mono ${isNavToken ? "text-green-700 dark:text-green-400" : deviationColorClass(Math.abs(deviationBps))}`}
        >
          {formatPegDeviation(coinData.price, pegRef)}
          {isNavToken && (
            <span
              className="text-xs text-muted-foreground ml-1"
              title="Price reflects NAV appreciation — not a peg deviation"
            >
              (NAV token)
            </span>
          )}
          {!isNavToken && usesFallbackPegRate && (
            <span
              className="text-xs text-muted-foreground ml-1"
              title="Peg reference: ECB FX rate (not market-derived)"
            >
              (ECB rate)
            </span>
          )}
        </p>
      </div>
    </>
  );
}

function HeroMarketCapContent({
  mcap,
  prevDay,
  prevDayTrendClass,
  hasPrevDay,
  chainCount,
}: {
  mcap: number;
  prevDay: number | null;
  prevDayTrendClass: string;
  hasPrevDay: boolean;
  chainCount: number;
}) {
  return (
    <>
      <div className="text-xl font-bold font-mono tracking-tight leading-none">{formatCurrency(mcap)}</div>
      <p className={`text-xs font-mono tabular-nums mt-0.5 ${prevDayTrendClass}`}>
        {hasPrevDay ? formatPercentChange(mcap, prevDay!) : "—"}{" "}
        <span className="text-muted-foreground">24h</span>
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">
        {chainCount} chain{chainCount !== 1 ? "s" : ""}
      </p>
    </>
  );
}

function HeroSupplyContent({
  mcap,
  supply,
  symbol,
  prevWeek,
  prevWeekTrendClass,
  hasPrevWeek,
  prevMonth,
  prevMonthTrendClass,
  hasPrevMonth,
  prev90d,
  prev90dTrendClass,
  include90d,
}: {
  mcap: number;
  supply: number | null;
  symbol: string;
  prevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevWeek: boolean;
  prevMonth: number | null;
  prevMonthTrendClass: string;
  hasPrevMonth: boolean;
  prev90d: number;
  prev90dTrendClass: string;
  include90d: boolean;
}) {
  return (
    <>
      <div className="text-xl font-bold font-mono tracking-tight leading-none">
        {supply != null ? formatSupply(supply) : "—"}{" "}
        <span className="text-sm text-muted-foreground">{symbol}</span>
      </div>
      <p className="text-xs font-mono tabular-nums mt-0.5">
        <span className={prevWeekTrendClass}>{hasPrevWeek ? formatPercentChange(mcap, prevWeek!) : "—"}</span>
        <span className="text-muted-foreground"> 7d</span>
        {hasPrevMonth && (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={prevMonthTrendClass}>
              {formatPercentChange(mcap, prevMonth!)}
            </span>
            <span className="text-muted-foreground"> 30d</span>
          </>
        )}
        {include90d && prev90d > 0 && (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={prev90dTrendClass}>{formatPercentChange(mcap, prev90d)}</span>
            <span className="text-muted-foreground"> 90d</span>
          </>
        )}
      </p>
    </>
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
  prev90d,
  pegRef,
  deviationBps,
  gaugeDeviationBps,
  usesFallbackPegRate,
  pegScoreResult,
  recordedDepegEventCount,
  pegScoreBorderClass,
  liquidityData,
  liqBorderClass,
  reportCard,
  onOpenFeedback,
}: HeroCardProps) {
  const chainCount = coinData?.chains?.length ?? 0;
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
  const prev90dTrendClass = prev90d > 0
    ? mcap >= prev90d
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

  const pegScoreContent = !isNavToken ? (
    pegScoreResult?.pegScore != null ? (
      <>
        <div
          className={`text-xl font-bold font-mono tracking-tight leading-none ${pegScoreColor(pegScoreResult.pegScore)}`}
        >
          {pegScoreResult.pegScore}
          <span className="text-sm text-muted-foreground">/100</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono mt-0.5">{pegScoreResult.pegPct.toFixed(1)}% at peg</p>
        {earlyPegScore ? (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5" title="Score is based on limited history and may change as more data accumulates.">
            Early score · {pegScoreResult.trackingSpanDays}d tracked
          </p>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            title={recordedDepegEventCount != null && recordedDepegEventCount !== pegScoreResult.eventCount
              ? "Recorded count includes full history. Peg score uses a rolling 4-year event window."
              : undefined}
          >
            {pegScoreEventLine}
          </p>
        )}
      </>
    ) : tooNewForPegScore ? (
      <details className="group">
        <summary className="pharos-focus-ring cursor-pointer list-none rounded-md [&::-webkit-details-marker]:hidden">
          <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground flex items-center gap-1.5">
            NR
            <span className="text-xs font-sans font-normal text-muted-foreground/50 group-open:hidden">why?</span>
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{pegScoreResult!.trackingSpanDays}d tracked</p>
        </summary>
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
          Peg score requires 7 days of history.{" "}
          {Math.ceil(7 - pegScoreResult!.trackingSpanDays)} day{Math.ceil(7 - pegScoreResult!.trackingSpanDays) !== 1 ? "s" : ""} remaining.
        </p>
      </details>
    ) : (
      <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">—</div>
    )
  ) : (
    <div className="text-sm font-medium text-muted-foreground">NAV Token</div>
  );

  const liquidityContent = (() => {
    const liq = liquidityData;
    if (liq == null || (liq.liquidityScore === null && liq.poolCount === 0)) {
      return <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">—</div>;
    }
    const score = liq.liquidityScore ?? 0;
    return (
      <>
        <div className={`text-xl font-bold font-mono tracking-tight leading-none ${getScoreColor(score)}`}>
          {Math.round(score)}
          <span className="text-sm text-muted-foreground">/100</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono mt-0.5">{formatCurrency(liq.totalTvlUsd)} TVL</p>
        <p className="text-xs text-muted-foreground">
          {liq.poolCount} pool{liq.poolCount !== 1 ? "s" : ""} · {liq.chainCount} chain{liq.chainCount !== 1 ? "s" : ""}
        </p>
      </>
    );
  })();

  return (
    <Card className="rounded-xl gap-0">
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

      <div className="px-4 sm:px-5 py-4">
        <div className="space-y-3 lg:hidden">
          <div className="space-y-1">
            <HeroIdentityHeader coin={coin} logoSrc={logoSrc} mobile />
            <HeroTagList tags={coin.tags} />
          </div>

          <div className="flex items-center gap-3 border-t border-border/30 pt-3">
            <HeroPriceContent
              coin={coin}
              coinData={coinData}
              pegRef={pegRef}
              gaugeDeviationBps={gaugeDeviationBps}
              isNavToken={isNavToken}
              deviationBps={deviationBps}
              usesFallbackPegRate={usesFallbackPegRate}
              gaugeClassName="w-full max-w-[80px]"
            />

            {reportCard && !reportCard.isDefunct && (
              <div className="border-l border-border/30 pl-3">
                <p className="mb-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <MethodologyLabel topic="safetyScore">Safety</MethodologyLabel>
                </p>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`shrink-0 text-lg px-2.5 py-0.5 font-bold ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
                  >
                    {reportCard.overallGrade}
                  </Badge>
                  {reportCard.overallScore !== null && (
                    <span className="text-lg font-bold font-mono tabular-nums tracking-tight leading-none">
                      {reportCard.overallScore}<span className="text-sm text-muted-foreground">/100</span>
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {pegScoreResult?.activeDepeg && (
            <div className="rounded-full border border-red-500/20 bg-red-500/8 px-3 py-1.5 text-xs text-red-700 dark:text-red-400">
              Active depeg
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <HeroMetricCard label="Market Cap">
              <HeroMarketCapContent
                mcap={mcap}
                prevDay={prevDay}
                prevDayTrendClass={prevDayTrendClass}
                hasPrevDay={hasPrevDay}
                chainCount={chainCount}
              />
            </HeroMetricCard>

            <HeroMetricCard label="Supply">
              <HeroSupplyContent
                mcap={mcap}
                supply={supply}
                symbol={coin.symbol}
                prevWeek={prevWeek}
                prevWeekTrendClass={prevWeekTrendClass}
                hasPrevWeek={hasPrevWeek}
                prevMonth={prevMonth}
                prevMonthTrendClass={prevMonthTrendClass}
                hasPrevMonth={hasPrevMonth}
                prev90d={prev90d}
                prev90dTrendClass={prev90dTrendClass}
                include90d={false}
              />
            </HeroMetricCard>

            <HeroMetricCard
              label={!isNavToken ? <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel> : "Type"}
              className={!isNavToken ? pegScoreBorderClass : ""}
            >
              {pegScoreContent}
            </HeroMetricCard>

            <HeroMetricCard label={<MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>} className={liqBorderClass}>
              {liquidityContent}
            </HeroMetricCard>
          </div>
        </div>

        <div className="hidden lg:flex lg:items-stretch gap-5">
          {/* Left column: identity + price + safety */}
          <div className="lg:w-[40%] flex flex-col">
            <div className="flex flex-col gap-1">
              <HeroIdentityHeader coin={coin} logoSrc={logoSrc} mobile={false} />
              <HeroTagList tags={coin.tags} />
            </div>

            <div className="mt-auto flex items-center gap-4 border-t border-border/30 pt-3">
              <HeroPriceContent
                coin={coin}
                coinData={coinData}
                pegRef={pegRef}
                gaugeDeviationBps={gaugeDeviationBps}
                isNavToken={isNavToken}
                deviationBps={deviationBps}
                usesFallbackPegRate={usesFallbackPegRate}
                gaugeClassName="w-full max-w-[88px]"
              />

              {reportCard && !reportCard.isDefunct && (
                <div className="border-l border-border/30 pl-4">
                  <p className="mb-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <MethodologyLabel topic="safetyScore">Safety</MethodologyLabel>
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`shrink-0 text-lg px-2.5 py-0.5 font-bold ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
                    >
                      {reportCard.overallGrade}
                    </Badge>
                    {reportCard.overallScore !== null && (
                      <span className="text-lg font-bold font-mono tabular-nums tracking-tight leading-none">
                        {reportCard.overallScore}<span className="text-sm text-muted-foreground">/100</span>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {pegScoreResult?.activeDepeg && (
              <div className="mt-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-3.5 py-2.5 text-xs">
                <span className="text-red-700 dark:text-red-400 font-medium">Active depeg</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="w-px bg-border/30" />

          {/* Right column: 2x2 metric grid */}
          <div className="flex-1 grid grid-cols-2 gap-3 content-start">
            <HeroMetricCard label="Market Cap">
              <HeroMarketCapContent
                mcap={mcap}
                prevDay={prevDay}
                prevDayTrendClass={prevDayTrendClass}
                hasPrevDay={hasPrevDay}
                chainCount={chainCount}
              />
            </HeroMetricCard>

            <HeroMetricCard label="Supply">
              <HeroSupplyContent
                mcap={mcap}
                supply={supply}
                symbol={coin.symbol}
                prevWeek={prevWeek}
                prevWeekTrendClass={prevWeekTrendClass}
                hasPrevWeek={hasPrevWeek}
                prevMonth={prevMonth}
                prevMonthTrendClass={prevMonthTrendClass}
                hasPrevMonth={hasPrevMonth}
                prev90d={prev90d}
                prev90dTrendClass={prev90dTrendClass}
                include90d
              />
            </HeroMetricCard>

            <HeroMetricCard
              label={!isNavToken ? <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel> : "Type"}
              className={!isNavToken ? pegScoreBorderClass : ""}
            >
              {pegScoreContent}
            </HeroMetricCard>

            <HeroMetricCard label={<MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>} className={liqBorderClass}>
              {liquidityContent}
            </HeroMetricCard>
          </div>
        </div>
      </div>
    </Card>
  );
}
