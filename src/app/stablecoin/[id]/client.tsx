"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowLeftRight, Flag } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange, formatSupply } from "@/lib/format";
import { derivePegRates, getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw, getPrevMonthRaw } from "@/lib/supply";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@/lib/classification";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { McapChart } from "@/components/mcap-chart";
import { DepegHistory } from "@/components/depeg-history";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { KeyInfoCard } from "@/components/key-info-card";
import { AiSummary } from "@/components/ai-summary";
import { ReportCardDetail } from "@/components/report-card";
import { CoinNotices } from "@/components/coin-notice";
import { DetailSectionNav } from "@/components/detail-section-nav";
import { PegGauge } from "@/components/peg-gauge";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { getReserves } from "@/lib/reserve-templates";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import type { StablecoinData, StablecoinMeta } from "@/lib/types";
import { pegScoreColor, getScoreColor, getScoreTier, TIER_BORDER, deviationColorClass } from "@/lib/severity-colors";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { FlowEventFeed } from "@/components/flow-event-feed";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { DEWSDetail } from "@/components/dews-detail";
import { CRON_15MIN, CRON_30MIN } from "@/hooks/use-api-query";

const DETAIL_SECTIONS = [
  { id: "report-card", label: "Safety Score" },
  { id: "overview", label: "Overview" },
  { id: "chart", label: "Chart" },
  { id: "info", label: "Info" },
  { id: "liquidity", label: "Liquidity" },
  { id: "flows", label: "Flows" },
  { id: "history", label: "Depeg History" },
];

interface SummaryData {
  title: string;
  text: string;
  updatedAt: string;
}

interface StablecoinDetailClientProps {
  id: string;
  summary: SummaryData | null;
  coin: StablecoinMeta;
  logoSrc?: string;
}

export default function StablecoinDetailClient({ id, summary, coin, logoSrc }: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { data: supplyData, isLoading: supplyLoading, isError: supplyError } = useSupplyHistory(id);
  const { data: listData, isLoading: listLoading, isError: listError, dataUpdatedAt: listUpdatedAt } = useStablecoins();
  const { data: pegSummaryData, dataUpdatedAt: pegUpdatedAt } = usePegSummary();
  const { data: liquidityMap, dataUpdatedAt: liqUpdatedAt } = useDexLiquidity();
  const { data: reportCardsData, dataUpdatedAt: rcUpdatedAt } = useReportCards();
  const reportCard = reportCardsData?.cards.find((c) => c.id === id);
  const coinData: StablecoinData | undefined = listData?.peggedAssets?.find(
    (c: StablecoinData) => c.id === id
  );
  const isNavToken = coin.flags.navToken ?? false;

  const isLoading = supplyLoading || listLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[280px] rounded-xl" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  if (listError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">Signal lost. Try again shortly.</p>
      </div>
    );
  }

  if (!coinData) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">This trail leads nowhere.</p>
      </div>
    );
  }

  const mcap = getCirculatingRaw(coinData);
  const price = coinData.price;
  const supply = (typeof price === "number" && price > 0) ? mcap / price : mcap;
  const prevDay = getPrevDayRaw(coinData);
  const prevWeek = getPrevWeekRaw(coinData);
  const prevMonth = getPrevMonthRaw(coinData);
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(listData?.peggedAssets ?? [], TRACKED_META_BY_ID, listData?.fxFallbackRates);
  const pegRef = getPegReference(coinData.pegType, pegRates, coin.commodityOunces);
  const deviationBps = (coinData.price != null && pegRef > 0)
    ? Math.round(((coinData.price - pegRef) / pegRef) * 10000)
    : 0;

  const supplyHistory = supplyData ?? [];
  const earliestTrackingDate = supplyHistory.length > 0 ? String(supplyHistory[0].date) : null;
  const pegScoreResult = pegSummaryData?.coins.find((c) => c.id === id) ?? null;

  const pegScoreBorderClass = (() => {
    const score = pegScoreResult?.pegScore;
    if (score == null) return "";
    if (score >= 90) return "border-l-2 border-l-green-500";
    if (score >= 70) return "border-l-2 border-l-amber-500";
    return "border-l-2 border-l-red-500";
  })();

  const liqBorderClass = (() => {
    const liq = liquidityMap?.[id];
    if (liq == null || liq.liquidityScore === null) return "";
    return `border-l-2 ${TIER_BORDER[getScoreTier(liq.liquidityScore)]}`;
  })();

  // Compute 90d mcap from supply history for change display
  const prev90d = (() => {
    if (supplyHistory.length === 0) return 0;
    const now = Date.now();
    const target = now - 90 * 24 * 60 * 60 * 1000;
    let closest = supplyHistory[0];
    for (const entry of supplyHistory) {
      const d = new Date(entry.date).getTime();
      if (Math.abs(d - target) < Math.abs(new Date(closest.date).getTime() - target)) {
        closest = entry;
      }
    }
    // Only use if within 7 days of target
    if (Math.abs(new Date(closest.date).getTime() - target) > 7 * 24 * 60 * 60 * 1000) return 0;
    return closest.circulatingUsd;
  })();

  return (
    <div className="space-y-6">
      {supplyError && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-600 dark:text-amber-400">
          Supply history is temporarily unavailable.
        </div>
      )}

      <StaleDataBanner
        queries={[
          { label: "Prices", dataUpdatedAt: listUpdatedAt, staleTime: CRON_15MIN },
          { label: "Peg Data", dataUpdatedAt: pegUpdatedAt, staleTime: CRON_15MIN },
          { label: "Liquidity", dataUpdatedAt: liqUpdatedAt, staleTime: CRON_30MIN },
          { label: "Report Cards", dataUpdatedAt: rcUpdatedAt, staleTime: CRON_15MIN },
        ]}
      />

      {/* HERO CARD */}
      <Card className="rounded-xl gap-0">
        {/* Top bar: breadcrumb + compare */}
        <div className="flex items-center justify-between px-5 pt-3 pb-2.5 border-b border-border/30">
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

        {/* Hero body: 2-column layout */}
        <div className="px-5 py-4">
          <div className="flex flex-col lg:flex-row lg:items-stretch gap-6">

            {/* LEFT: Identity + Price */}
            <div className="lg:w-[45%] flex flex-col gap-3">
              {/* Identity + classification group */}
              <div className="flex flex-col gap-1.5">
                {/* Identity row */}
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
                  <h1 className="text-2xl font-extrabold tracking-tighter">{coin.name}</h1>
                  <span className="text-lg text-muted-foreground font-mono">{coin.symbol}</span>
                  <BluechipHeaderBadge stablecoinId={coin.id} />
                </div>

                {/* Classification line */}
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

              {/* Price + Gauge */}
              <div className="flex items-center gap-4 mt-auto border-t border-border/30 pt-3">
                {coinData.price != null && pegRef > 0 && (
                  <PegGauge
                    deviationBps={isNavToken ? 0 : deviationBps}
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
                    {!isNavToken && pegRateSources[coinData.pegType ?? ""] === "fallback" && (
                      <span className="text-xs text-muted-foreground ml-1" title="Peg reference: ECB FX rate (not market-derived)">
                        (ECB rate)
                      </span>
                    )}
                  </p>
                  <button
                    onClick={() => setFeedbackOpen(true)}
                    className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Flag className="h-3 w-3" />
                    Report data issue
                  </button>
                </div>
              </div>
            </div>

            {/* Vertical divider (desktop only) */}
            <div className="hidden lg:block w-px bg-border/30 my-3" />

            {/* RIGHT: 2x2 Stats Grid */}
            <div className="lg:flex-1">
              <div className="grid grid-cols-2">
                {/* Top-left: Market Cap */}
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

                {/* Top-right: Supply */}
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

                {/* Bottom-left: Peg Score (NAV tokens show "Type: NAV Token" instead) */}
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

                {/* Bottom-right: Liquidity Score */}
                <div className={`px-3.5 py-2.5 min-h-[76px] ${liqBorderClass}`}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Liquidity</p>
                  {(() => {
                    const liq = liquidityMap?.[id];
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

              {/* Footer: active depeg warning */}
              {pegScoreResult?.activeDepeg && (
                <div className="px-3.5 pt-2.5 pb-2.5 border-t border-border/30 text-xs bg-red-500/5">
                  <span className="text-red-500 font-medium">Active depeg</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section nav as card bottom bar */}
        <div className="border-t border-border/30">
          <DetailSectionNav sections={DETAIL_SECTIONS} />
        </div>
      </Card>

      {/* Sections outside the card */}
      <section id="report-card">
        {reportCard && <ReportCardDetail card={reportCard} />}
      </section>

      <section id="overview">
        {(() => {
          const reserves = getReserves(coin);
          const hasLeft = !!(summary || reserves);
          const hasDews = !isNavToken;
          if (!hasLeft && !hasDews) return null;
          if (!hasLeft) return <DEWSDetail stablecoinId={id} />;
          return (
            <div className={`grid grid-cols-1 gap-6 ${hasDews ? "lg:grid-cols-2" : ""}`}>
              <div className="flex flex-col gap-6">
                {summary && <AiSummary {...summary} />}
                {reserves && (
                  <div>
                    <ReserveTreemap reserves={reserves.reserves} />
                    {reserves.estimated && (
                      <p className="mt-1 text-center text-xs text-muted-foreground">
                        Estimated composition based on {coin.flags.backing.replace("-", " ")} classification
                      </p>
                    )}
                  </div>
                )}
              </div>
              {hasDews && <DEWSDetail stablecoinId={id} />}
            </div>
          );
        })()}
      </section>

      {coin.notices && coin.notices.length > 0 && (
        <CoinNotices notices={coin.notices} />
      )}

      <section id="chart">
        <McapChart data={supplyHistory} />
      </section>

      <section id="info" className="space-y-6">
        <KeyInfoCard meta={coin} />
      </section>

      <section id="liquidity">
        <DexLiquidityCard stablecoinId={id} />
      </section>

      <section id="flows">
        <FlowSummaryCard stablecoinId={id} />
        <FlowEventFeed stablecoinId={id} limit={10} />
      </section>

      {!isNavToken && (
        <section id="history">
          <DepegHistory stablecoinId={id} earliestTrackingDate={earliestTrackingDate} hasPriceData={coinData.price != null} />
        </section>
      )}

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType="data-correction"
        stablecoinId={coin.id}
        stablecoinName={coin.name}
        pegValue={coinData.price != null ? `$${coinData.price.toFixed(6)}` : undefined}
      />
    </div>
  );
}
