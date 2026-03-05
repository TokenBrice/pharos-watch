"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { PegGauge } from "@/components/peg-gauge";
import { Card } from "@/components/ui/card";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@/lib/classification";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
} from "@/lib/format";
import {
  deviationColorClass,
  getScoreColor,
  pegScoreColor,
} from "@/lib/severity-colors";
import type { DexLiquidityData, PegSummaryCoin, StablecoinData, StablecoinMeta } from "@/lib/types";

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
  return (
    <Card className="rounded-xl gap-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 pt-3 pb-2.5 border-b border-border/30">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground" aria-current="page">{coin.name}</span>
        </nav>
        <Link
          href={`/compare/?coins=${coin.symbol.toLowerCase()}`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
          Compare
        </Link>
      </div>

      <div className="px-4 sm:px-5 py-4">
        <div className="flex flex-col lg:flex-row lg:items-stretch gap-6">
          <div className="lg:w-[45%] flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-3">
                {logoSrc ? (
                  <Image
                    src={logoSrc}
                    alt={`${coin.name} logo`}
                    width={48}
                    height={48}
                    className="rounded-full flex-shrink-0"
                    unoptimized
                  />
                ) : (
                  <div
                    className="flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground"
                    style={{ width: 48, height: 48 }}
                  >
                    {coin.name.charAt(0).toUpperCase()}
                  </div>
                )}
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
                    <span key={tag} className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground border-border/60 bg-muted/40">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-auto border-t border-border/30 pt-3">
              {coinData.price != null && pegRef > 0 && (
                <PegGauge
                  deviationBps={gaugeDeviationBps}
                  className="w-full max-w-[110px]"
                />
              )}
              <div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef)}
                </div>
                <p className={`text-sm font-mono ${isNavToken ? "text-green-500" : deviationColorClass(Math.abs(deviationBps))}`}>
                  {formatPegDeviation(coinData.price, pegRef)}
                  {isNavToken && (
                    <span className="text-xs text-muted-foreground ml-1" title="Price reflects NAV appreciation — not a peg deviation">
                      (NAV token)
                    </span>
                  )}
                  {!isNavToken && usesFallbackPegRate && (
                    <span className="text-xs text-muted-foreground ml-1" title="Peg reference: ECB FX rate (not market-derived)">
                      (ECB rate)
                    </span>
                  )}
                </p>
                <button
                  onClick={onOpenFeedback}
                  className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Flag className="h-3 w-3" />
                  Report data issue
                </button>
              </div>
            </div>
          </div>

          <div className="hidden lg:block w-px bg-border/30 my-3" />

          <div className="lg:flex-1">
            <div className="grid grid-cols-2">
              <div className="px-3.5 py-2.5 min-h-[76px] border-b border-r border-border/30">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Market Cap</p>
                <div className="text-xl font-bold font-mono tracking-tight leading-none">{formatCurrency(mcap)}</div>
                <p className={`text-xs font-mono tabular-nums mt-0.5 ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
                  {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"} <span className="text-muted-foreground">24h</span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {coinData?.chains?.length ?? 0} chain{(coinData?.chains?.length ?? 0) !== 1 ? "s" : ""}
                </p>
              </div>

              <div className="px-3.5 py-2.5 min-h-[76px] border-b border-border/30">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Supply</p>
                <div className="text-xl font-bold font-mono tracking-tight leading-none">{formatSupply(supply)} <span className="text-sm text-muted-foreground">{coin.symbol}</span></div>
                <p className="text-xs font-mono tabular-nums mt-0.5">
                  <span className={mcap >= prevWeek ? "text-green-500" : "text-red-500"}>
                    {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"}
                  </span>
                  <span className="text-muted-foreground"> 7d</span>
                  {prevMonth > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className={mcap >= prevMonth ? "text-green-500" : "text-red-500"}>
                        {formatPercentChange(mcap, prevMonth)}
                      </span>
                      <span className="text-muted-foreground"> 30d</span>
                    </>
                  )}
                  {prev90d > 0 && (
                    <>
                      <span className="text-muted-foreground"> · </span>
                      <span className={mcap >= prev90d ? "text-green-500" : "text-red-500"}>
                        {formatPercentChange(mcap, prev90d)}
                      </span>
                      <span className="text-muted-foreground"> 90d</span>
                    </>
                  )}
                </p>
              </div>

              {!isNavToken ? (
                <div className={`px-3.5 py-2.5 min-h-[76px] border-r border-border/30 ${pegScoreBorderClass}`}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Peg Score</p>
                  {pegScoreResult?.pegScore != null ? (
                    <>
                      <div className={`text-xl font-bold font-mono tracking-tight leading-none ${pegScoreColor(pegScoreResult.pegScore)}`}>
                        {pegScoreResult.pegScore}<span className="text-sm text-muted-foreground">/100</span>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {pegScoreResult.pegPct.toFixed(1)}% at peg
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {pegScoreResult.eventCount} event{pegScoreResult.eventCount !== 1 ? "s" : ""}
                      </p>
                    </>
                  ) : (
                    <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
                  )}
                </div>
              ) : (
                <div className="px-3.5 py-2.5 min-h-[76px] border-r border-border/30">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Type</p>
                  <div className="text-sm font-medium text-muted-foreground">NAV Token</div>
                </div>
              )}

              <div className={`px-3.5 py-2.5 min-h-[76px] ${liqBorderClass}`}>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Liquidity</p>
                {(() => {
                  const liq = liquidityData;
                  if (liq == null || (liq.liquidityScore === null && liq.poolCount === 0)) {
                    return <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>;
                  }
                  const score = liq.liquidityScore ?? 0;
                  return (
                    <>
                      <div className={`text-xl font-bold font-mono tracking-tight leading-none ${getScoreColor(score)}`}>
                        {Math.round(score)}<span className="text-sm text-muted-foreground">/100</span>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {formatCurrency(liq.totalTvlUsd)} TVL
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {liq.poolCount} pool{liq.poolCount !== 1 ? "s" : ""} · {liq.chainCount} chain{liq.chainCount !== 1 ? "s" : ""}
                      </p>
                    </>
                  );
                })()}
              </div>
            </div>

            {pegScoreResult?.activeDepeg && (
              <div className="px-3.5 pt-2.5 pb-2.5 border-t border-border/30 text-xs bg-red-500/5">
                <span className="text-red-500 font-medium">Active depeg</span>
              </div>
            )}
          </div>
        </div>
      </div>

    </Card>
  );
}
