"use client";

import dynamic from "next/dynamic";
import { useLogos } from "@/hooks/use-logos";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import { useCompareDataModel } from "@/hooks/use-compare-data-model";
import { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { formatCurrency } from "@shared/lib/format";
import { CoinSelector } from "@/components/coin-selector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Share2, Twitter, Download } from "lucide-react";
import { DIMENSION_ORDER, DIMENSION_SHORT_LABELS } from "@shared/lib/report-cards";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { CompareEmptyState } from "@/components/compare-empty-state";
import {
  COMPARISON_PRESETS,
  MAX_COMPARE_COINS,
} from "@/lib/compare-config";

const ComparisonTable = dynamic(() => import("@/components/comparison-table").then((m) => m.ComparisonTable), {
  loading: () => <ChartSkeleton className="h-[340px] rounded-xl" />,
});

const ComparisonChart = dynamic(() => import("@/components/comparison-chart").then((m) => m.ComparisonChart), {
  loading: () => <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />,
});

const CompareRadar = dynamic(() => import("@/components/radar-chart").then((m) => m.CompareRadar), {
  loading: () => <ChartSkeleton className="h-[420px] rounded-xl" />,
});

const FlowComparisonChart = dynamic(
  () => import("@/components/flow-comparison-chart").then((m) => ({ default: m.FlowComparisonChart })),
  { loading: () => <div className="h-[280px] rounded-xl animate-pulse bg-muted/20" /> },
);

export function CompareClient() {
  const { data: logos } = useLogos();
  const {
    applyPreset,
    coinOptions,
    disabledIds,
    flowHours,
    handleRemove,
    handleSelect,
    range,
    selectedCoins,
    selectedIds,
    setFlowHours,
    setRange,
  } = useCompareSelection();

  const {
    bcUpdatedAt,
    bluechipData,
    bluechipError,
    comparisonCoins,
    dataUpdatedAt,
    detailErrors,
    detailLoading,
    dexData,
    dexError,
    flowCardData,
    flowCoinQueries,
    flowData,
    flowSeries,
    globalError,
    handleRetry,
    liqUpdatedAt,
    listData,
    listError,
    pegError,
    pegRates,
    pegSummary,
    pegUpdatedAt,
    radarCards,
    rcUpdatedAt,
    reportCardsData,
    reportCardsError,
    supplySeries,
  } = useCompareDataModel({
    selectedIds,
    flowHours,
  });

  const { handleDownload, handleTwitterShare, handleWebShare, shareLoading, toast } = useCompareShareActions({
    comparisonCoins,
    logos,
    pegRates,
    radarCards,
    dimensionOrder: DIMENSION_ORDER,
    dimensionLabels: DIMENSION_SHORT_LABELS,
  });

  // Render selector slots (filled slots + empty slots up to MAX_COINS)
  const slots = [];
  for (let i = 0; i < MAX_COMPARE_COINS; i++) {
    const coin = selectedCoins[i] ?? null;
    slots.push(
      <CoinSelector
        key={i}
        coins={coinOptions}
        selected={coin}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={(c) => handleSelect(i, c)}
        onRemove={() => handleRemove(i)}
      />,
    );
  }

  return (
    <div className="space-y-6">
      <QueryErrorNotice error={globalError} hasData={!!listData?.peggedAssets?.length} onRetry={handleRetry} />
      <StaleDataBanner
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: listError, hasData: !!listData?.peggedAssets?.length },
          { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegSummary?.coins?.length },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: dexError, hasData: !!dexData },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
          },
          { preset: "bluechip", dataUpdatedAt: bcUpdatedAt, error: bluechipError, hasData: !!bluechipData },
        ]}
      />
      {selectedIds.length >= 2 && (
        <div className="flex items-center justify-end gap-2">
          {toast && <span className="text-xs text-muted-foreground animate-in fade-in duration-300">{toast}</span>}
          <button
            onClick={handleTwitterShare}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            title="Share on Twitter/X"
          >
            <Twitter className="h-3.5 w-3.5" />
            Tweet
          </button>
          <button
            onClick={handleWebShare}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            title="Share comparison"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
          <button
            onClick={handleDownload}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            title="Download comparison image"
          >
            <Download className="h-3.5 w-3.5" />
            Image
          </button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{slots}</div>

      {selectedIds.length < 2 && (
        <CompareEmptyState
          presets={COMPARISON_PRESETS}
          logos={logos}
          onApplyPreset={(preset) => applyPreset(preset.coins, preset.title)}
        />
      )}

      {selectedIds.length >= 2 && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <ComparisonTable coins={comparisonCoins} pegRates={pegRates} logos={logos} detailErrors={detailErrors} />

          {/* Live Flow Signals */}
          {flowCoinQueries.length > 0 && flowCoinQueries.every((q) => q.isError) && (
            <QueryErrorNotice
              error={flowCoinQueries[0]?.error as Error | null}
              hasData={false}
              onRetry={() => flowCoinQueries.forEach((q) => void q.refetch())}
            />
          )}
          {(flowCardData.length > 0 || flowSeries.length > 0) && (
            <div className="rounded-2xl border border-border/60 bg-card/50 p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="pharos-kicker">
                  Live Flow Signals
                </h3>
                {flowData?.updatedAt && (
                  <span className="text-xs text-muted-foreground">
                    Updated {Math.round((Date.now() / 1000 - flowData.updatedAt) / 60)} min ago · Ethereum
                  </span>
                )}
              </div>

              {/* Per-coin flow cards */}
              {flowCardData.length > 0 && (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${Math.min(flowCardData.length, 5)}, minmax(0, 1fr))` }}
                >
                  {flowCardData.map((card) => (
                    <CoinFlowCard key={card.id} {...card} />
                  ))}
                </div>
              )}

              {/* Net flow chart */}
              {flowSeries.length >= 2 && (
                <FlowComparisonChart
                  series={flowSeries}
                  hours={flowHours}
                  onHoursChange={(h) => setFlowHours(h as 24 | 168 | 720)}
                />
              )}

              {/* Coverage note */}
              {selectedIds.length > flowCardData.length && (
                <p className="text-xs text-muted-foreground">
                  {flowCardData.length} of {selectedIds.length} selected coins have Ethereum flow tracking.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {detailLoading ? (
              <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />
            ) : (
              supplySeries.length >= 2 && (
                <ComparisonChart
                  title="Market Cap History Comparison"
                  series={supplySeries}
                  formatValue={formatCurrency}
                  range={range}
                  onRangeChange={setRange}
                  normalizable
                />
              )
            )}

            {radarCards.length >= 2 && (
              <Card className="h-full flex flex-col">
                <CardHeader>
                  <CardTitle className="pharos-kicker">Safety Score Comparison</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col items-center justify-center">
                  <CompareRadar cards={radarCards} size={350} />
                  <div className="flex flex-wrap gap-3 justify-center mt-3">
                    {radarCards.map(({ card, color }) => (
                      <div key={card.id} className="flex items-center gap-1.5 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                        <span>
                          {card.symbol}: {card.overallGrade}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
