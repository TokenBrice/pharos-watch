"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { NonUsdShareChart } from "@/components/non-usd-share-chart";
import { useDexLiquidityTable, useNonUsdShare, usePegSummary, useReportCardsV9Table, useStablecoinCharts } from "@/hooks/api-hooks";
import { TimeRangeOption, isTimeRangeOption } from "@/hooks/use-time-range-filter";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { AltPegCohortHistoryChart } from "./alt-peg-cohort-history-chart";
import { AltPegStablecoinTable } from "./alt-peg-stablecoin-table";
import { FiatWorldAtlas } from "./fiat-world-atlas/world-atlas";
import { NonUsdHero } from "./non-usd-hero";
import { PegRanking } from "./peg-ranking";
import {
  buildAltPegSnapshot,
  buildAltPegTrendStats,
  parseAltPegParam,
} from "@/lib/alt-peg-market";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { PegCurrency } from "@shared/types";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";

type FocusedChart = "share" | "cohorts";

const DEFAULT_HISTORY_RANGE: TimeRangeOption = "1y";
const STABLECOINS_INTERVAL_SEC = CRON_INTERVALS["sync-stablecoins"]!;

function isFocusedChart(value: string | null): value is FocusedChart {
  return value === "share" || value === "cohorts";
}

export function AltPegsClient() {
  const stablecoinsQuery = useStablecoins();
  const shareQuery = useNonUsdShare();
  // Start cohort history alongside the independent current-market read.
  useStablecoinCharts();
  const pegSummaryQuery = usePegSummary();
  const dexLiquidityQuery = useDexLiquidityTable();
  const reportCardsQuery = useReportCardsV9Table();
  const logos = logosById;
  const { searchParams, setParam, pushSearchParams, replaceParams } = useUrlFilters();
  const setSelectedPeg = useCallback(
    (peg: PegCurrency | null) => setParam("peg", peg ? peg.toLowerCase() : ""),
    [setParam],
  );

  const snapshot = useMemo(
    () => buildAltPegSnapshot(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
  // A peg with no core coins (or an unknown code) is not a filter: the page shows every peg, never an empty table.
  const selectedPeg = useMemo(() => {
    const peg = parseAltPegParam(searchParams.get("peg"));
    return peg && snapshot.distributionRows.some((row) => row.peg === peg) ? peg : null;
  }, [searchParams, snapshot.distributionRows]);
  const tableInputs = useMemo(
    () =>
      buildStablecoinTableInputs({
        stablecoins: stablecoinsQuery.data?.peggedAssets,
        fxFallbackRates: stablecoinsQuery.data?.fxFallbackRates,
        pegSummaryCoins: pegSummaryQuery.data?.coins,
        reportCardsV9: reportCardsQuery.data,
      }),
    [
      stablecoinsQuery.data?.peggedAssets,
      stablecoinsQuery.data?.fxFallbackRates,
      pegSummaryQuery.data?.coins,
      reportCardsQuery.data,
    ],
  );
  const trendStats = useMemo(() => buildAltPegTrendStats(shareQuery.data), [shareQuery.data]);
  const focusedChart = useMemo(() => {
    const view = searchParams.get("view");
    const chart = searchParams.get("chart");
    return view === "focused" && isFocusedChart(chart) ? chart : null;
  }, [searchParams]);
  const focusedRange = useMemo(() => {
    const range = searchParams.get("range");
    return range && isTimeRangeOption(range) ? range : DEFAULT_HISTORY_RANGE;
  }, [searchParams]);
  const [shareRange, setShareRange] = useState<TimeRangeOption>(() =>
    focusedChart === "share" ? focusedRange : DEFAULT_HISTORY_RANGE,
  );
  const [cohortRange, setCohortRange] = useState<TimeRangeOption>(() =>
    focusedChart === "cohorts" ? focusedRange : DEFAULT_HISTORY_RANGE,
  );

  const openFocusedChart = useCallback(
    (chart: FocusedChart, range: TimeRangeOption) => {
      pushSearchParams((params) => {
        params.set("view", "focused");
        params.set("chart", chart);
        params.set("range", range);
      });
    },
    [pushSearchParams],
  );

  const closeFocusedChart = useCallback(() => {
    if (focusedChart === "share") setShareRange(focusedRange);
    if (focusedChart === "cohorts") setCohortRange(focusedRange);
    replaceParams((params) => {
      params.delete("view");
      params.delete("chart");
      params.delete("range");
    });
  }, [focusedChart, focusedRange, replaceParams]);

  const setFocusedRange = useCallback(
    (chart: FocusedChart, range: TimeRangeOption) => {
      replaceParams((params) => {
        params.set("view", "focused");
        params.set("chart", chart);
        params.set("range", range);
      });
    },
    [replaceParams],
  );

  if (stablecoinsQuery.isLoading && !stablecoinsQuery.data?.peggedAssets?.length) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[280px] w-full rounded-xl" />
        <Skeleton className="h-[520px] w-full rounded-xl" />
        <Skeleton className="h-[360px] w-full rounded-xl" />
        <Skeleton className="h-[360px] w-full rounded-xl" />
      </div>
    );
  }

  if (!stablecoinsQuery.isLoading && snapshot.altCoinCount === 0) {
    return (
      <QueryErrorNotice
        error={stablecoinsQuery.error ?? new Error("Alt-peg market data is temporarily unavailable.")}
        hasData={false}
        onRetry={() => {
          void stablecoinsQuery.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200 motion-reduce:animate-none">
      <StaleDataBanner
        queries={[
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
            isLoading: stablecoinsQuery.isLoading,
            error: stablecoinsQuery.error,
            hasData: snapshot.altCoinCount > 0,
            meta: stablecoinsQuery.meta,
          },
          {
            label: "Non-USD Share",
            dataUpdatedAt: shareQuery.dataUpdatedAt,
            staleTime: API_FRESHNESS_MAX_AGE_SEC.nonUsdShare * 1000,
            isLoading: shareQuery.isLoading,
            error: shareQuery.error,
            hasData: !!shareQuery.data?.length,
            meta: shareQuery.meta,
          },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegSummaryQuery.dataUpdatedAt,
            error: pegSummaryQuery.error,
            hasData: !!pegSummaryQuery.data?.coins?.length,
            meta: pegSummaryQuery.meta,
          },
          {
            preset: "dexLiquidity",
            dataUpdatedAt: dexLiquidityQuery.dataUpdatedAt,
            error: dexLiquidityQuery.error,
            hasData: !!dexLiquidityQuery.data,
            meta: dexLiquidityQuery.meta,
          },
          {
            preset: "reportCards",
            dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
            error: reportCardsQuery.error,
            hasData: !!reportCardsQuery.data?.cards?.length,
            meta: reportCardsQuery.meta,
          },
        ]}
      />
      {stablecoinsQuery.isError ? (
        <QueryErrorNotice error={stablecoinsQuery.error} hasData onRetry={() => void stablecoinsQuery.refetch()} />
      ) : null}

      <NonUsdHero
        snapshot={snapshot}
        trendStats={trendStats}
        supplyAsOfSec={stablecoinsQuery.meta?.updatedAt ?? null}
      />

      <FiatWorldAtlas />

      <PegRanking
        rows={snapshot.distributionRows}
        partial={snapshot.altSupplyUnavailableCount > 0 || snapshot.altSupplyPartialCount > 0}
        selectedPeg={selectedPeg}
        onSelect={setSelectedPeg}
      />

      <SectionErrorBoundary name="alt-peg-stablecoin-table">
        <AltPegStablecoinTable
          data={stablecoinsQuery.data?.peggedAssets}
          isLoading={stablecoinsQuery.isLoading}
          unavailable={Boolean(stablecoinsQuery.error)}
          pegRows={snapshot.distributionRows}
          selectedPeg={selectedPeg}
          onSelectPeg={setSelectedPeg}
          logos={logos}
          pegScores={tableInputs.pegScores}
          dexLiquidity={dexLiquidityQuery.data ?? undefined}
          reportCards={tableInputs.reportCards}
          reportCardsMethodologyVersion={reportCardsQuery.data?.safetyScoreIdentity?.methodologyVersion ?? null}
          sourceGenerations={{
            stablecoins: stablecoinsQuery.meta?.updatedAt,
            pegSummary: pegSummaryQuery.meta?.updatedAt,
            dexLiquidity: dexLiquidityQuery.meta?.updatedAt,
            reportCards: reportCardsQuery.meta?.updatedAt,
          }}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="non-usd-share">
        <section id="alt-peg-history-share" className="scroll-mt-24">
          <NonUsdShareChart
            key={focusedChart === "share" ? `share-focused-${focusedRange}` : `share-overview-${shareRange}`}
            initialRange={focusedChart === "share" ? focusedRange : shareRange}
            isFocused={focusedChart === "share"}
            onOpenFocus={(range) => openFocusedChart("share", range)}
            onCloseFocus={closeFocusedChart}
            onRangeChange={(range) => {
              setShareRange(range);
              if (focusedChart === "share") {
                setFocusedRange("share", range);
              }
            }}
          />
        </section>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="alt-peg-cohort-growth">
        <AltPegCohortHistoryChart
          key={focusedChart === "cohorts" ? `cohorts-focused-${focusedRange}` : `cohorts-overview-${cohortRange}`}
          initialRange={focusedChart === "cohorts" ? focusedRange : cohortRange}
          isFocused={focusedChart === "cohorts"}
          onOpenFocus={(range) => openFocusedChart("cohorts", range)}
          onCloseFocus={closeFocusedChart}
          onRangeChange={(range) => {
            setCohortRange(range);
            if (focusedChart === "cohorts") {
              setFocusedRange("cohorts", range);
            }
          }}
        />
      </SectionErrorBoundary>

      <footer className="space-y-1 border-t border-border/50 pt-4 text-xs text-muted-foreground">
        <p>
          Current figures: Pharos stablecoin list over the core universe, refreshed every{" "}
          <span className="pharos-numeric">{Math.round(STABLECOINS_INTERVAL_SEC / 60)}</span> minutes. History: provider-wide
          supply snapshots, a different population, so its latest sample is never read as the current cap.
        </p>
        <p>
          Euro stablecoins are reshaped by EU MiCA rules; see the{" "}
          <Link href="/compliance/?regime=mica" className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground">
            Compliance Tracker
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}
