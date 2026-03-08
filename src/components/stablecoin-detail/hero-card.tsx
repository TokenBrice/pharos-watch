"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
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
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityData, PegSummaryCoin, StablecoinData, StablecoinMeta } from "@shared/types";

interface HeroCardProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  isNavToken: boolean;
  mcap: number;
  supply: number;
  prevDay: number;
  prevWeek: number;
  prevMonth: number;
  prev90d: number;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  usesFallbackPegRate: boolean;
  pegScoreResult: PegSummaryCoin | null;
  pegScoreBorderClass: string;
  liquidityData: DexLiquidityData | undefined;
  liqBorderClass: string;
  onOpenFeedback: () => void;
}

function HeroMetricCard({
  label,
  className = "",
  children,
}: {
  label: string;
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
  pegScoreBorderClass,
  liquidityData,
  liqBorderClass,
  onOpenFeedback,
}: HeroCardProps) {
  const chainCount = coinData?.chains?.length ?? 0;
  const primaryComparisonPage = getPrimaryStaticComparisonPageForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);

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
        <p className="text-xs text-muted-foreground">
          {pegScoreResult.eventCount} event{pegScoreResult.eventCount !== 1 ? "s" : ""}
        </p>
      </>
    ) : (
      <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
    )
  ) : (
    <div className="text-sm font-medium text-muted-foreground">NAV Token</div>
  );

  const liquidityContent = (() => {
    const liq = liquidityData;
    if (liq == null || (liq.liquidityScore === null && liq.poolCount === 0)) {
      return <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>;
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
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground" aria-current="page">
            {coin.name}
          </span>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href={compareHref}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            {primaryComparisonPage ? `Compare ${coin.symbol}` : "Compare"}
          </Link>
          <ShareButton ogPath={`/api/og/stablecoin/${coin.id}`} label="Share" />
        </div>
      </div>

      <div className="px-4 sm:px-5 py-4">
        <div className="space-y-5 lg:hidden">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <StablecoinLogo src={logoSrc} name={coin.name} size={52} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 text-2xl font-extrabold tracking-tighter">{coin.name}</h2>
                  <span className="text-base font-mono text-muted-foreground">{coin.symbol}</span>
                  <BluechipHeaderBadge stablecoinId={coin.id} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
                  {" \u00b7 "}
                  {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
                  {" \u00b7 "}
                  {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
                </p>
              </div>
            </div>
            {coin.tags && coin.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {coin.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground border-border/60 bg-muted/40"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-4">
            <div className="flex items-center gap-4">
              {coinData.price != null && pegRef > 0 && (
                <PegGauge deviationBps={gaugeDeviationBps} className="w-full max-w-[108px]" />
              )}
              <div className="min-w-0">
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef)}
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
                <button
                  onClick={onOpenFeedback}
                  className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-11"
                >
                  <Flag className="h-3 w-3" />
                  Report data issue
                </button>
              </div>
            </div>
            {pegScoreResult?.activeDepeg && (
              <div className="mt-3 rounded-full border border-red-500/20 bg-red-500/8 px-3 py-1.5 text-xs text-red-700 dark:text-red-400">
                Active depeg
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <HeroMetricCard label="Market Cap">
              <div className="text-xl font-bold font-mono tracking-tight leading-none">{formatCurrency(mcap)}</div>
              <p
                className={`text-xs font-mono tabular-nums mt-0.5 ${mcap >= prevDay ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
              >
                {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"}{" "}
                <span className="text-muted-foreground">24h</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {chainCount} chain{chainCount !== 1 ? "s" : ""}
              </p>
            </HeroMetricCard>

            <HeroMetricCard
              label={!isNavToken ? "Peg Score" : "Type"}
              className={!isNavToken ? pegScoreBorderClass : ""}
            >
              {pegScoreContent}
            </HeroMetricCard>
          </div>

          <details className="rounded-2xl border border-border/60 bg-background/45">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
              More market detail
            </summary>
            <div className="grid gap-3 border-t border-border/50 px-4 pb-4 pt-4 sm:grid-cols-2">
              <HeroMetricCard label="Supply">
                <div className="text-xl font-bold font-mono tracking-tight leading-none">
                  {formatSupply(supply)} <span className="text-sm text-muted-foreground">{coin.symbol}</span>
                </div>
                <p className="text-xs font-mono tabular-nums mt-0.5">
                  <span
                    className={
                      mcap >= prevWeek ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                    }
                  >
                    {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"}
                  </span>
                  <span className="text-muted-foreground"> 7d</span>
                  {prevMonth > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span
                        className={
                          mcap >= prevMonth ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        }
                      >
                        {formatPercentChange(mcap, prevMonth)}
                      </span>
                      <span className="text-muted-foreground"> 30d</span>
                    </>
                  )}
                </p>
              </HeroMetricCard>

              <HeroMetricCard label="Liquidity" className={liqBorderClass}>
                {liquidityContent}
              </HeroMetricCard>
            </div>
          </details>
        </div>

        <div className="hidden lg:flex lg:flex-row lg:items-stretch gap-6">
          <div className="lg:w-[45%] flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-3">
                <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
                <h2 className="text-2xl font-extrabold tracking-tighter">{coin.name}</h2>
                <span className="text-lg text-muted-foreground font-mono">{coin.symbol}</span>
                <BluechipHeaderBadge stablecoinId={coin.id} />
              </div>

              <p className="text-sm text-muted-foreground">
                {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
                {" \u00b7 "}
                {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
                {" \u00b7 "}
                {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
              </p>
              {coin.tags && coin.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {coin.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground border-border/60 bg-muted/40"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-auto border-t border-border/30 pt-3">
              {coinData.price != null && pegRef > 0 && (
                <PegGauge deviationBps={gaugeDeviationBps} className="w-full max-w-[110px]" />
              )}
              <div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef)}
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
                <button
                  onClick={onOpenFeedback}
                  className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-11 sm:min-h-0"
                >
                  <Flag className="h-3 w-3" />
                  Report data issue
                </button>
              </div>
            </div>
          </div>

          <div className="w-px bg-border/30 my-3" />

          <div className="lg:flex-1">
            <div className="grid grid-cols-2 gap-3">
              <HeroMetricCard label="Market Cap">
                <div className="text-xl font-bold font-mono tracking-tight leading-none">{formatCurrency(mcap)}</div>
                <p
                  className={`text-xs font-mono tabular-nums mt-0.5 ${mcap >= prevDay ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                >
                  {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"}{" "}
                  <span className="text-muted-foreground">24h</span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {chainCount} chain{chainCount !== 1 ? "s" : ""}
                </p>
              </HeroMetricCard>

              <HeroMetricCard label="Supply">
                <div className="text-xl font-bold font-mono tracking-tight leading-none">
                  {formatSupply(supply)} <span className="text-sm text-muted-foreground">{coin.symbol}</span>
                </div>
                <p className="text-xs font-mono tabular-nums mt-0.5">
                  <span
                    className={
                      mcap >= prevWeek ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                    }
                  >
                    {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"}
                  </span>
                  <span className="text-muted-foreground"> 7d</span>
                  {prevMonth > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span
                        className={
                          mcap >= prevMonth ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        }
                      >
                        {formatPercentChange(mcap, prevMonth)}
                      </span>
                      <span className="text-muted-foreground"> 30d</span>
                    </>
                  )}
                  {prev90d > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span
                        className={
                          mcap >= prev90d ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        }
                      >
                        {formatPercentChange(mcap, prev90d)}
                      </span>
                      <span className="text-muted-foreground"> 90d</span>
                    </>
                  )}
                </p>
              </HeroMetricCard>

              <HeroMetricCard
                label={!isNavToken ? "Peg Score" : "Type"}
                className={!isNavToken ? pegScoreBorderClass : ""}
              >
                {pegScoreContent}
              </HeroMetricCard>

              <HeroMetricCard label="Liquidity" className={liqBorderClass}>
                {liquidityContent}
              </HeroMetricCard>
            </div>

            {pegScoreResult?.activeDepeg && (
              <div className="mt-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-3.5 py-2.5 text-xs">
                <span className="text-red-700 dark:text-red-400 font-medium">Active depeg</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
