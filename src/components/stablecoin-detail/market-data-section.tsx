"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ChartBrush, MarketDataChartSyncProvider, useMarketDataChartSync } from "@/components/chart-primitives/sync";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { LazySection } from "@/components/lazy-section";
import { McapChart } from "@/components/chart-primitives/mcap-chart";
import { PegDeviationChart } from "@/components/chart-primitives/peg-deviation-chart";
import { ChartRangeToggle } from "@/components/chart-primitives/scale-toggle";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { cn } from "@/lib/utils";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { Button } from "@/components/ui/button";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { deriveDataHealth, isPublicWarning, type DataHealthInfo } from "@/lib/data-health";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { deviationColorClass } from "@/lib/severity-colors";
import { formatBps } from "@shared/lib/format";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";

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
  /** The hero's live figures, so chart headers agree with it; lines stay on daily snapshots. */
  current?: { mcap: number | null; prevDay: number | null; price: number | null; deviationBps: number | null };
}

/**
 * Unified "Market Data" block pairing `McapChart` + `PegDeviationChart` under a
 * single time-range selector. The range is owned here and pushed down via the
 * `controlledRange` prop on each chart; shared brushing and crosshairs keep
 * the ordinary price and market-cap series synchronized.
 */
export function MarketDataSection({ stablecoinId, supplyHistory, pegCurrency, updatedAtMs, frozenNote, current }: MarketDataSectionProps) {
  // 90d default: recent structure is the read this page optimizes for; "all"
  // compresses a decade of supply into an unreadable first paint.
  const [range, setRange] = useState<TimeRangeOption>("90d");
  const needsExpandedHistory = range === "1y" || range === "all";
  const expandedHistoryQuery = useSupplyHistory(stablecoinId, range === "all" ? "all" : 365, {
    enabled: needsExpandedHistory,
  });
  const hasExpandedHistory = needsExpandedHistory && expandedHistoryQuery.data.length > 0;
  const activeHistory = hasExpandedHistory ? expandedHistoryQuery.data : supplyHistory;
  // Notices name the range as its button does.
  const requestedRange = range === "all" ? "All" : "1y";
  // One verdict for the retained expansion's chip and notice (ADR-42): its own producer
  // generation, budgets and server floor; null authority never renews from receipt.
  const expandedHealthInput = {
    label: `${requestedRange} history`,
    staleTime: API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000,
    dataUpdatedAt: expandedHistoryQuery.dataUpdatedAt,
    error: expandedHistoryQuery.error,
    hasData: hasExpandedHistory,
    meta: expandedHistoryQuery.meta,
  };
  const nowMs = useFreshnessBoundary([expandedHealthInput], hasExpandedHistory);
  const expandedHealth = hasExpandedHistory
    ? deriveDataHealth(expandedHealthInput, nowMs ?? expandedHistoryQuery.dataUpdatedAt)
    : null;
  const expandedWarning = expandedHealth != null && isPublicWarning(expandedHealth);
  const historyStatus = !needsExpandedHistory ? null
    : hasExpandedHistory
      ? expandedWarning ? `${requestedRange} history is ${expandedHealth?.state === "stale" ? "stale" : "of unknown freshness"}.` : null
    : expandedHistoryQuery.error ? `${requestedRange} history could not be loaded. Requested coverage is not confirmed.`
    : expandedHistoryQuery.isLoading || expandedHistoryQuery.isFetching ? `Loading ${requestedRange} history. Requested coverage is not yet confirmed.`
    : `No observations returned for ${requestedRange} history. Requested coverage is unavailable.`;
  const historyNotice = historyStatus ? (
    <div role="status" aria-label="Market history coverage" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <p>
        {historyStatus}{" "}
        {hasExpandedHistory
          ? `Observations from ${new Date(activeHistory[0].date * 1000).toISOString().slice(0, 10)} to ${new Date(activeHistory[activeHistory.length - 1].date * 1000).toISOString().slice(0, 10)}.`
          : activeHistory.length > 0 ? "Only the available 90-day window is shown." : "No observations are available to show."}
      </p>
      {(!hasExpandedHistory && expandedHistoryQuery.error) || expandedHealth?.state === "stale" ? (
        <Button variant="outline" size="sm" disabled={expandedHistoryQuery.isFetching} onClick={() => void expandedHistoryQuery.refetch()}>
          Retry {requestedRange} history
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <MarketDataChartSyncProvider>
      <MarketDataSectionBody
        stablecoinId={stablecoinId}
        supplyHistory={activeHistory}
        pegCurrency={pegCurrency}
        updatedAtMs={expandedHealth ? expandedHealth.dataUpdatedAt : updatedAtMs}
        health={expandedHealth}
        frozenNote={frozenNote}
        current={current}
        historyNotice={historyNotice}
        range={range}
        setRange={setRange}
      />
    </MarketDataChartSyncProvider>
  );
}
interface MarketDataSectionBodyProps extends MarketDataSectionProps {
  range: TimeRangeOption;
  setRange: (next: TimeRangeOption) => void;
  historyNotice: ReactNode;
  /** The selected retained expansion's public verdict; null keeps the seed chip's own band. */
  health: DataHealthInfo | null;
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
  historyNotice,
  health,
  range,
  setRange,
  current,
}: MarketDataSectionBodyProps) {
  const sync = useMarketDataChartSync();
  // Daily history carries USD prices only. A USD peg's reference is $1 on every
  // day; other pegs need a dated FX/commodity reference series Pharos does not
  // publish, so their USD price is charted and their deviation is stated for the
  // live quote.
  const deviationCharted = pegCurrency === "USD";
  const pegName = getPegTaxonomyByCurrency(pegCurrency ?? undefined)?.presentation.shortLabel ?? pegCurrency;

  // Brush domain matches the active controlled range, not the entire supply
  // history — brushing inside "30d" lets you focus a few days. A history
  // shorter than the range starts at its first observation, so a pre-history
  // sliver of the strip cannot be brushed into an empty chart.
  const brushDomain = useMemo<readonly [number, number] | null>(() => {
    if (supplyHistory.length === 0) return null;
    const firstTs = (supplyHistory[0].date ?? 0) * 1000;
    const lastTs = (supplyHistory[supplyHistory.length - 1].date ?? 0) * 1000;
    if (range === "all") return [firstTs, lastTs];
    const cutoff = RANGE_MS[range];
    if (!cutoff) return null;
    return [Math.max(lastTs - cutoff, firstTs), lastTs];
  }, [range, supplyHistory]);

  // The strip draws the market cap in small under the selection.
  const brushSeries = useMemo(
    () => supplyHistory.map((point) => ({ ts: point.date * 1000, value: point.circulatingUsd })),
    [supplyHistory],
  );

  // Clear brush when the active range changes — the previous selection no
  // longer makes sense in the new domain. `setBrushedRange` is stable from
  // the provider (memoized) so it's safe to include.
  const setBrushedRange = sync?.setBrushedRange;
  useEffect(() => {
    setBrushedRange?.(null);
  }, [range, setBrushedRange]);

  return (
    <section aria-label="Market data charts" className={DETAIL_MODULE_SHELL_CLASS}>
      <div className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Market data</StablecoinModuleTitle>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {updatedAtMs ? (
            <FreshnessIndicator
              compact
              updatedAtMs={updatedAtMs}
              staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.supplyHistory * 1000}
              health={health ?? undefined}
              labelPrefix="Updated"
            />
          ) : null}
          <ChartRangeToggle options={TIME_RANGE_OPTIONS} value={range} onChange={setRange} />
        </div>
      </div>
      <div className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {frozenNote}
        {historyNotice}
        <div className="overflow-hidden rounded-lg border border-border/50 bg-card/40 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
          <div className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <LazySection className="min-h-[340px] sm:min-h-[420px]">
              <McapChart
                data={supplyHistory}
                stablecoinId={stablecoinId}
                controlledRange={range}
                embedded
                current={current}
              />
            </LazySection>
            <LazySection className="min-h-[340px] sm:min-h-[420px]">
              <PegDeviationChart
                data={supplyHistory}
                pegCurrency={pegCurrency}
                controlledRange={range}
                embedded
                current={current}
              />
            </LazySection>
          </div>
          {!deviationCharted && pegName ? (
            <p className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground sm:px-6">
              <span className="font-medium text-foreground">Peg vs {pegName}:</span>{" "}
              {current?.deviationBps != null ? (
                <>
                  <span className={cn("pharos-numeric", deviationColorClass(Math.abs(current.deviationBps)))}>
                    {formatBps(current.deviationBps)}
                  </span>{" "}
                  now.
                </>
              ) : (
                "unavailable now."
              )}{" "}
              Price is charted in USD; daily deviation is not, as Pharos keeps no dated {pegName} reference series.
            </p>
          ) : null}
          {brushDomain && sync ? (
            // A drag strip fights page scroll on touch; touch readers use the range presets.
            <div className="border-t border-border/50 px-4 py-2 pointer-coarse:hidden sm:px-6">
              <div className="mb-1 flex items-center justify-between gap-3">
                <p className="pharos-label">Brush</p>
                {sync.brushedRange ? (
                  <button
                    type="button"
                    onClick={() => sync.setBrushedRange(null)}
                    className="pharos-label pharos-focus-ring hover:text-foreground"
                  >
                    Clear
                  </button>
                ) : (
                  <span className="text-3xs text-muted-foreground/70">Drag to focus a window</span>
                )}
              </div>
              <ChartBrush domain={brushDomain} value={sync.brushedRange} onChange={sync.setBrushedRange} series={brushSeries} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
