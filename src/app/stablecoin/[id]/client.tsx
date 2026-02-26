"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange, formatSupply } from "@/lib/format";
import { derivePegRates, getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw, getPrevMonthRaw } from "@/lib/supply";
import { computePegScoreWithWindow } from "@/lib/peg-score";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { McapChart } from "@/components/mcap-chart";
import { DepegHistory } from "@/components/depeg-history";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { KeyInfoCard } from "@/components/key-info-card";
import { ContractAddresses } from "@/components/contract-addresses";
import { BluechipBox } from "@/components/bluechip-box";
import { LiquidityBox } from "@/components/liquidity-box";
import { AiSummary } from "@/components/ai-summary";
import { ReportCardDetail } from "@/components/report-card";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import type { StablecoinData } from "@/lib/types";
import { pegScoreColor } from "@/lib/severity-colors";

interface SummaryData {
  title: string;
  text: string;
  updatedAt: string;
}

export default function StablecoinDetailClient({ id, summary }: { id: string; summary: SummaryData | null }) {
  const { data: supplyData, isLoading: supplyLoading, isError: supplyError } = useSupplyHistory(id);
  const { data: listData, isLoading: listLoading, isError: listError } = useStablecoins();
  const { data: depegData } = useDepegEvents(id);
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
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
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
  const prevMonth = getPrevMonthRaw(coinData);
  const metaById = TRACKED_META_BY_ID;
  const { rates: pegRates } = derivePegRates(listData?.peggedAssets ?? [], metaById, listData?.fxFallbackRates);
  const pegRef = getPegReference(coinData.pegType, pegRates, meta?.commodityOunces);

  const supplyHistory = supplyData ?? [];
  const earliestTrackingDate = supplyHistory.length > 0 ? String(supplyHistory[0].date) : null;
  const pegScoreResult = computePegScoreWithWindow(isNavToken, depegData?.events ?? null, earliestTrackingDate);

  return (
    <div className="space-y-6">
      {supplyError && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-600 dark:text-amber-400">
          Supply history is temporarily unavailable.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
        <Card className="rounded-xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatNativePrice(coinData.price, meta?.flags.pegCurrency ?? "USD", pegRef)}</div>
            <p className="text-sm text-muted-foreground font-mono">{formatPegDeviation(coinData.price, pegRef)}</p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Market Cap</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(mcap)}</div>
            <p className="text-sm text-muted-foreground">
              {coinData.chains?.length ?? 0} chains
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supply (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatSupply(supply)}</div>
            <p className={`text-sm font-mono ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
              {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supply Changes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">7d</span>
              <span className={`font-mono ${mcap >= prevWeek ? "text-green-500" : "text-red-500"}`}>
                {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">30d</span>
              <span className={`font-mono ${mcap >= prevMonth ? "text-green-500" : "text-red-500"}`}>
                {prevMonth > 0 ? formatPercentChange(mcap, prevMonth) : "N/A"}
              </span>
            </div>
          </CardContent>
        </Card>

        {!isNavToken && (
          <Card className="rounded-xl border-l-[3px] border-l-emerald-500">

            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Peg Score</CardTitle>
            </CardHeader>
            <CardContent>
              {pegScoreResult?.pegScore !== null && pegScoreResult?.pegScore !== undefined ? (
                <>
                  <div className={`text-2xl font-bold font-mono tracking-tight ${pegScoreColor(pegScoreResult.pegScore)}`}>
                    {pegScoreResult.pegScore}<span className="text-lg text-muted-foreground">/100</span>
                  </div>
                  <p className="text-sm text-muted-foreground font-mono">
                    {pegScoreResult.pegPct.toFixed(1)}% at peg
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {pegScoreResult.eventCount} depeg event{pegScoreResult.eventCount !== 1 ? "s" : ""}
                  </p>
                </>
              ) : (
                <div className="text-2xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
              )}
            </CardContent>
          </Card>
        )}

        <BluechipBox stablecoinId={id} ratingsMap={ratingsMap} />
        <LiquidityBox stablecoinId={id} liquidityMap={liquidityMap} />
      </div>

      {summary && <AiSummary {...summary} />}

      {reportCard && <ReportCardDetail card={reportCard} />}

      <McapChart data={supplyHistory} />


      {meta && (
        <KeyInfoCard meta={meta} />
      )}

      {meta && (
        <ContractAddresses meta={meta} />
      )}

      <DexLiquidityCard stablecoinId={id} />

      <DepegHistory stablecoinId={id} earliestTrackingDate={earliestTrackingDate} />

    </div>
  );
}
