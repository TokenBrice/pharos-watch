"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChartAnnotationLegend } from "@/components/chart-primitives";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { LazySection } from "@/components/lazy-section";
import { McapChart } from "@/components/mcap-chart";
import { PegDeviationChart } from "@/components/peg-deviation-chart";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

const TIME_RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];

interface MarketDataSectionProps {
  stablecoinId: string;
  supplyHistory: SupplyHistoryPoint[];
  pegCurrency: string | null | undefined;
  /** Optional frozen-state notice rendered above the chart pair. */
  frozenNote?: ReactNode;
}

/**
 * Unified "Market Data" block pairing `McapChart` + `PegDeviationChart` under a
 * single time-range selector and a single shared annotation legend. The range
 * is owned here and pushed down via the `controlledRange` prop on each chart;
 * the legend spans the full supply-history window so it remains stable when
 * the range changes (reference-line markers inside each chart stay gated to
 * the visible window via `ifOverflow="hidden"`).
 */
export function MarketDataSection({
  stablecoinId,
  supplyHistory,
  pegCurrency,
  frozenNote,
}: MarketDataSectionProps) {
  const [range, setRange] = useState<TimeRangeOption>("all");

  const fromMs =
    supplyHistory.length > 0 ? (supplyHistory[0].date ?? 0) * 1000 : null;
  const toMs =
    supplyHistory.length > 0
      ? (supplyHistory[supplyHistory.length - 1].date ?? 0) * 1000
      : null;
  const { data: annotations } = useChartAnnotations(stablecoinId, fromMs, toMs);

  return (
    <section id="chart" aria-label="Market data charts" className="space-y-4">
      <div className="flex flex-row items-center justify-between gap-3">
        <DetailSectionTitle>Market Data</DetailSectionTitle>
        <TimeRangeButtons
          options={TIME_RANGE_OPTIONS}
          value={range}
          onChange={setRange}
        />
      </div>
      {frozenNote}
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card/40 animate-in fade-in duration-300">
        <div className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <LazySection className="min-h-[340px] sm:min-h-[420px]">
            <McapChart
              data={supplyHistory}
              stablecoinId={stablecoinId}
              hideAnnotationLegend
              controlledRange={range}
              embedded
            />
          </LazySection>
          <LazySection className="min-h-[340px] sm:min-h-[420px]">
            <PegDeviationChart
              data={supplyHistory}
              pegCurrency={pegCurrency}
              stablecoinId={stablecoinId}
              hideAnnotationLegend
              controlledRange={range}
              embedded
            />
          </LazySection>
        </div>
        {annotations.length > 0 ? (
          <div className="border-t border-border/50 px-4 py-3 sm:px-6">
            <ChartAnnotationLegend
              annotations={annotations}
              numbered
              className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
