"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange, formatSupply } from "@/lib/format";
import { derivePegRates, getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@/lib/supply";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { McapChart } from "@/components/mcap-chart";
import { DepegHistory } from "@/components/depeg-history";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { KeyInfoCard } from "@/components/key-info-card";
import { ContractAddresses } from "@/components/contract-addresses";
import { BluechipBox } from "@/components/bluechip-box";
import { AiSummary } from "@/components/ai-summary";
import { ReportCardDetail } from "@/components/report-card";
import { DetailSectionNav } from "@/components/detail-section-nav";
import { PegGauge } from "@/components/peg-gauge";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import type { StablecoinData } from "@/lib/types";
import { pegScoreColor, getScoreColor } from "@/lib/severity-colors";

const DETAIL_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "report-card", label: "Report Card" },
  { id: "chart", label: "Chart" },
  { id: "info", label: "Info" },
  { id: "liquidity", label: "Liquidity" },
  { id: "history", label: "History" },
];

interface SummaryData {
  title: string;
  text: string;
  updatedAt: string;
}

export default function StablecoinDetailClient({ id, summary }: { id: string; summary: SummaryData | null }) {
  const { data: supplyData, isLoading: supplyLoading, isError: supplyError } = useSupplyHistory(id);
  const { data: listData, isLoading: listLoading, isError: listError } = useStablecoins();
  const { data: depegData } = useDepegEvents(id);
  const { data: pegSummaryData } = usePegSummary();
  const { data: ratingsMap } = useBluechipRatings();
  const { data: liquidityMap } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();
  const reportCard = reportCardsData?.cards.find((c) => c.id === id);
  const meta = TRACKED_META_BY_ID.get(id);
  const coinData: StablecoinData | undefined = listData?.peggedAssets?.find(
    (c: StablecoinData) => c.id === id
  );
  const isNavToken = meta?.flags.navToken ?? false;

  const isLoading = supplyLoading || listLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-3 sm:gap-5 grid-cols-1 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
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

  const metaById = TRACKED_META_BY_ID;
  const { rates: pegRates } = derivePegRates(listData?.peggedAssets ?? [], metaById, listData?.fxFallbackRates);
  const pegRef = getPegReference(coinData.pegType, pegRates, meta?.commodityOunces);

  const supplyHistory = supplyData ?? [];
  const earliestTrackingDate = supplyHistory.length > 0 ? String(supplyHistory[0].date) : null;
  const pegScoreResult = pegSummaryData?.coins.find((c) => c.id === id) ?? null;

  return (
    <div className="space-y-6">
      {supplyError && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-600 dark:text-amber-400">
          Supply history is temporarily unavailable.
        </div>
      )}

      <DetailSectionNav sections={DETAIL_SECTIONS} />

      <section id="overview">
        {/* Primary stats row – Left: Market Cap+Supply | Center: Price | Right: Peg+Liquidity */}
        <div className="grid gap-3 sm:gap-5 grid-cols-1 sm:grid-cols-3">

          {/* LEFT: Market Cap + Supply side-by-side with 24h/7d changes */}
          <Card className="rounded-xl border-l-[3px] border-l-violet-500">
            <CardContent className="pt-4 pb-4">
              <div className="grid grid-cols-2 gap-x-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Market Cap</p>
                  <div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatCurrency(mcap)}</div>
                  <p className={`text-xs font-mono mt-1 ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
                    {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"} <span className="text-muted-foreground">24h</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Supply</p>
                  <div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatSupply(supply)}</div>
                  <p className={`text-xs font-mono mt-1 ${mcap >= prevWeek ? "text-green-500" : "text-red-500"}`}>
                    {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"} <span className="text-muted-foreground">7d</span>
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                {coinData.chains?.length ?? 0} chain{(coinData.chains?.length ?? 0) !== 1 ? "s" : ""}
              </p>
            </CardContent>
          </Card>

          {/* CENTER: Price */}
          <Card className="rounded-xl border-l-[3px] border-l-blue-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center text-center">
              {coinData.price != null && pegRef > 0 && (
                <PegGauge
                  deviationBps={Math.round(((coinData.price - pegRef) / pegRef) * 10000)}
                  className="w-full max-w-[180px] -mt-1 mb-2"
                />
              )}
              <div className="text-2xl font-bold font-mono tracking-tight">{formatNativePrice(coinData.price, meta?.flags.pegCurrency ?? "USD", pegRef)}</div>
              <p className="text-sm text-muted-foreground font-mono">{formatPegDeviation(coinData.price, pegRef)}</p>
            </CardContent>
          </Card>

          {/* RIGHT: Peg Score + Liquidity Score side-by-side */}
          <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
            <CardContent className="pt-4 pb-4">
              {(() => {
                const liq = liquidityMap?.[id];
                const hasLiq = liq != null && (liq.liquidityScore !== null || liq.poolCount > 0);
                const score = liq?.liquidityScore ?? 0;
                const textColor = hasLiq ? getScoreColor(score) : "";
                const showBoth = !isNavToken && hasLiq;
                return (
                  <div className={`grid gap-x-5 ${showBoth ? "grid-cols-2" : "grid-cols-1"}`}>
                    {!isNavToken && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Peg Score</p>
                        {pegScoreResult?.pegScore !== null && pegScoreResult?.pegScore !== undefined ? (
                          <>
                            <div className={`text-xl font-bold font-mono tracking-tight leading-tight ${pegScoreColor(pegScoreResult.pegScore)}`}>
                              {pegScoreResult.pegScore}<span className="text-base text-muted-foreground">/100</span>
                            </div>
                            <p className="text-xs text-muted-foreground font-mono mt-1">
                              {pegScoreResult.pegPct.toFixed(1)}% at peg
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {pegScoreResult.eventCount} depeg event{pegScoreResult.eventCount !== 1 ? "s" : ""}
                            </p>
                          </>
                        ) : (
                          <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
                        )}
                      </div>
                    )}
                    {hasLiq && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Liq. Score</p>
                        <div className={`text-xl font-bold font-mono tracking-tight leading-tight ${textColor}`}>
                          {Math.round(score)}<span className="text-base text-muted-foreground">/100</span>
                        </div>
                        <p className="text-xs text-muted-foreground font-mono mt-1">
                          {formatCurrency(liq!.totalTvlUsd)} TVL
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {liq!.poolCount} pool{liq!.poolCount !== 1 ? "s" : ""} &middot; {liq!.chainCount} chain{liq!.chainCount !== 1 ? "s" : ""}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </div>

        {/* Secondary row – Bluechip rating */}
        <div className="mt-3 sm:mt-5">
          <BluechipBox stablecoinId={id} ratingsMap={ratingsMap} />
        </div>

        {summary && <AiSummary {...summary} />}
      </section>

      <section id="report-card">
        {reportCard && <ReportCardDetail card={reportCard} />}
      </section>

      <section id="chart">
        <McapChart data={supplyHistory} />
      </section>

      <section id="info">
        {meta && <KeyInfoCard meta={meta} />}
        {meta && <ContractAddresses meta={meta} />}
        {meta?.reserves && <ReserveTreemap reserves={meta.reserves} />}
      </section>

      <section id="liquidity">
        <DexLiquidityCard stablecoinId={id} />
      </section>

      <section id="history">
        <DepegHistory stablecoinId={id} earliestTrackingDate={earliestTrackingDate} />
      </section>
    </div>
  );
}
