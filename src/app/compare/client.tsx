"use client";

import Link from "next/link";
import { useMemo } from "react";
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
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { CompareEmptyState } from "@/components/compare-empty-state";
import { buildStablecoinUrl } from "@/lib/urls";
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
  const activeSelectionLabel = selectedCoins
    .filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null)
    .map((coin) => coin.symbol)
    .join(" vs ");
  const selectionInsights = useMemo(() => {
    if (selectedIds.length < 2) return null;

    const peerCoins =
      comparisonCoins.length >= 2
        ? comparisonCoins
        : selectedCoins.filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null);

    if (peerCoins.length < 2) {
      return {
        lens: "Build the peer set first, then read peg behavior, liquidity, and safety in the same frame instead of hopping between detail pages.",
        cohort: "Live metadata is still loading for the selected set.",
        structure: "The comparison panels below will sharpen once the full dataset lands.",
        links: selectedCoins.filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null),
      };
    }

    const comparisonMeta = comparisonCoins.length >= 2 ? comparisonCoins : null;
    if (!comparisonMeta) {
      return {
        lens: "Build the peer set first, then read peg behavior, liquidity, and safety in the same frame instead of hopping between detail pages.",
        cohort: "Live metadata is still loading for the selected set.",
        structure: "The comparison panels below will sharpen once the full dataset lands.",
        links: peerCoins,
      };
    }

    const pegSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.pegCurrency));
    const governanceSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.governance));
    const backingSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.backing));

    const lens =
      pegSet.size === 1
        ? "Same-peg peer set. Read this screen as a true substitution decision: who keeps the peg cleaner, stays more liquid, and carries the cleaner structural risk profile."
        : "Cross-peg set. Structural differences matter more here than raw deviation, so use the panels below to separate currency exposure from stablecoin design risk.";

    const cohort =
      governanceSet.size === 1
        ? `Shared governance model across the set: ${GOVERNANCE_LABELS[comparisonMeta[0].meta.flags.governance] ?? comparisonMeta[0].meta.flags.governance}.`
        : "Mixed governance models across the selected assets.";

    const structure =
      backingSet.size === 1
        ? `Shared backing profile: ${BACKING_LABELS[comparisonMeta[0].meta.flags.backing] ?? comparisonMeta[0].meta.flags.backing}.`
        : "Mixed backing structures across the set.";

    const pegContext =
      pegSet.size === 1
        ? `Common peg target: ${PEG_LABELS_SHORT[comparisonMeta[0].meta.flags.pegCurrency] ?? comparisonMeta[0].meta.flags.pegCurrency}.`
        : "Multiple peg targets are represented in the selected set.";

    return { lens, cohort, structure: `${structure} ${pegContext}`, links: comparisonMeta };
  }, [comparisonCoins, selectedCoins, selectedIds]);

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
      {selectedIds.length >= 2 ? (
        <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="pharos-kicker">Active Comparison</p>
                <p className="truncate text-sm text-foreground">
                  {activeSelectionLabel}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Shareable link · up to {MAX_COMPARE_COINS} assets · live data
              </p>
            </div>
            {selectionInsights ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="rounded-2xl border border-border/60 bg-background/50 px-3.5 py-3">
                  <p className="pharos-kicker">How To Read This Set</p>
                  <p className="mt-1 text-sm text-foreground">{selectionInsights.lens}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionInsights.cohort} {selectionInsights.structure}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-background/50 px-3.5 py-3">
                  <p className="pharos-kicker">Jump To Detail</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectionInsights.links.map((coin) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-9"
                      >
                        {coin.symbol} detail
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {selectedIds.length >= 2 && (
        <div className="flex items-center justify-end gap-2">
          {toast && <span className="text-xs text-muted-foreground animate-in fade-in duration-300">{toast}</span>}
          <button
            onClick={handleTwitterShare}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            aria-label="Share comparison on Twitter"
            title="Share on Twitter/X"
          >
            <Twitter className="h-3.5 w-3.5" />
            Tweet
          </button>
          <button
            onClick={handleWebShare}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            aria-label="Share comparison link or image"
            title="Share comparison"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
          <button
            onClick={handleDownload}
            disabled={shareLoading}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            aria-label="Download comparison as image"
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
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
                  <CompareRadar cards={radarCards} size={300} />
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
