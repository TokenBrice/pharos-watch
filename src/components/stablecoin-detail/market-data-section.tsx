"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ChartAnnotationLegend } from "@/components/chart-primitives/annotations";
import { ChartBrush, MarketDataChartSyncProvider, useMarketDataChartSync } from "@/components/chart-primitives/sync";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { LazySection } from "@/components/lazy-section";
import { McapChart } from "@/components/mcap-chart";
import { PegDeviationChart } from "@/components/peg-deviation-chart";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { cn } from "@/lib/utils";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

const TIME_RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];

const RANGE_MS: Record<string, number> = {
  "7d": 7 * 86400000,
  "30d": 30 * 86400000,
  "90d": 90 * 86400000,
  "1y": 365 * 86400000,
};

interface MarketDataSectionProps {
  stablecoinId: string;
  supplyHistory: SupplyHistoryPoint[];
  pegCurrency: string | null | undefined;
  /** Supply query freshness for the header chip. */
  updatedAtMs?: number;
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
export function MarketDataSection({ stablecoinId, supplyHistory, pegCurrency, updatedAtMs, frozenNote }: MarketDataSectionProps) {
  // 90d default: recent structure is the read this page optimizes for; "all"
  // compresses a decade of supply into an unreadable first paint.
  const [range, setRange] = useState<TimeRangeOption>("90d");

  return (
    <MarketDataChartSyncProvider>
      <MarketDataSectionBody
        stablecoinId={stablecoinId}
        supplyHistory={supplyHistory}
        pegCurrency={pegCurrency}
        updatedAtMs={updatedAtMs}
        frozenNote={frozenNote}
        range={range}
        setRange={setRange}
      />
    </MarketDataChartSyncProvider>
  );
}
interface MarketDataSectionBodyProps extends MarketDataSectionProps {
  range: TimeRangeOption;
  setRange: (next: TimeRangeOption) => void;
}

/**
 * Inner body — kept separate so we can call `useMarketDataChartSync()` for
 * the brush wiring (the provider must be in scope).
 */
function MarketDataSectionBody({
  stablecoinId,
  supplyHistory,
  pegCurrency,
  updatedAtMs,
  frozenNote,
  range,
  setRange,
}: MarketDataSectionBodyProps) {
  const sync = useMarketDataChartSync();

  // Brush domain matches the active controlled range, not the entire supply
  // history — brushing inside "30d" lets you focus a few days.
  const brushDomain = useMemo<readonly [number, number] | null>(() => {
    if (supplyHistory.length === 0) return null;
    const lastTs = (supplyHistory[supplyHistory.length - 1].date ?? 0) * 1000;
    if (range === "all") {
      const firstTs = (supplyHistory[0].date ?? 0) * 1000;
      return [firstTs, lastTs];
    }
    const cutoff = RANGE_MS[range];
    if (!cutoff) return null;
    return [lastTs - cutoff, lastTs];
  }, [range, supplyHistory]);

  // Clear brush when the active range changes — the previous selection no
  // longer makes sense in the new domain. `setBrushedRange` is stable from
  // the provider (memoized) so it's safe to include.
  const setBrushedRange = sync?.setBrushedRange;
  useEffect(() => {
    setBrushedRange?.(null);
  }, [range, setBrushedRange]);

  // Annotation legend reflects the brushed window when present, else the
  // full controlled range.
  const annotationFromMs = sync?.brushedRange?.[0] ?? brushDomain?.[0] ?? null;
  const annotationToMs = sync?.brushedRange?.[1] ?? brushDomain?.[1] ?? null;
  const { data: annotations } = useChartAnnotations(stablecoinId, annotationFromMs, annotationToMs);

  return (
    <section id="chart" aria-label="Market data charts" className={DETAIL_MODULE_SHELL_CLASS}>
      <div className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Market Data</StablecoinModuleTitle>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAtMs ? (
            <FreshnessIndicator
              compact
              updatedAtMs={updatedAtMs}
              staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000}
              labelPrefix="Updated"
            />
          ) : null}
          <TimeRangeButtons options={TIME_RANGE_OPTIONS} value={range} onChange={setRange} />
        </div>
      </div>
      <div className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {frozenNote}
        <div className="overflow-hidden rounded-lg border border-border/50 bg-card/40 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
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
          {brushDomain && sync ? (
            <div className="border-t border-border/50 px-4 py-2 sm:px-6">
              <div className="mb-1 flex items-center justify-between gap-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Brush</p>
                {sync.brushedRange ? (
                  <button
                    type="button"
                    onClick={() => sync.setBrushedRange(null)}
                    className="pharos-focus-ring text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground/70">Drag to focus a window</span>
                )}
              </div>
              <ChartBrush domain={brushDomain} value={sync.brushedRange} onChange={sync.setBrushedRange} />
            </div>
          ) : null}
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
      </div>
    </section>
  );
}
