"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { NonUsdShareChart } from "@/components/non-usd-share-chart";
import { useDexLiquidity, useNonUsdShare, usePegSummary, useReportCardsV9 } from "@/hooks/api-hooks";
import { TimeRangeOption, isTimeRangeOption } from "@/hooks/use-time-range-filter";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { AltPegCohortHistoryChart } from "./alt-peg-cohort-history-chart";
import { AltPegStablecoinTable } from "./alt-peg-stablecoin-table";
import { FiatWorldAtlas } from "./fiat-world-atlas/world-atlas";
import {
  buildAltPegSnapshot,
  buildAltPegTrendStats,
} from "@/lib/alt-peg-market";
import { formatCurrency, formatPercent, formatSignedPercent } from "@shared/lib/format";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";

type FocusedChart = "share" | "cohorts";

const DEFAULT_HISTORY_RANGE: TimeRangeOption = "1y";

function isFocusedChart(value: string | null): value is FocusedChart {
  return value === "share" || value === "cohorts";
}

// Commodities vs. all other non-USD pegs — demoted out of the hero into a flat
// band below the workbench table.
function AltPegMixBand({
  marketCap,
  fiatNonUsdMarketCap,
  commodityMarketCap,
}: {
  marketCap: number;
  fiatNonUsdMarketCap: number;
  commodityMarketCap: number;
}) {
  const commodityShare = marketCap > 0 ? (commodityMarketCap / marketCap) * 100 : 0;
  const nonCommodityShare = marketCap > 0 ? (fiatNonUsdMarketCap / marketCap) * 100 : 0;

  return (
    <section aria-label="All alt-peg mix" className="pharos-card-shell space-y-4 p-5 sm:p-6">
      <div className="space-y-1">
        <p className="pharos-kicker">All Alt-Peg Mix</p>
        <p className="pharos-meta">Commodities vs. all other non-USD pegs across the tracked alt-peg market.</p>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/35">
        <div className="h-full bg-[color:var(--chart-5)]" style={{ width: `${commodityShare}%` }} />
        <div className="h-full bg-[color:var(--brand-accent)]" style={{ width: `${nonCommodityShare}%` }} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="pharos-kicker flex items-center gap-2">
            <span className="size-2 rounded-full bg-[color:var(--chart-5)]" aria-hidden="true" />
            Commodities
          </p>
          <p className="mt-1 pharos-numeric text-base font-semibold text-foreground">
            {formatCurrency(commodityMarketCap, 1)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatPercent(commodityShare)} of alt-peg market</p>
        </div>
        <div>
          <p className="pharos-kicker flex items-center gap-2">
            <span className="size-2 rounded-full bg-[color:var(--brand-accent)]" aria-hidden="true" />
            Non-commodity non-USD
          </p>
          <p className="mt-1 pharos-numeric text-base font-semibold text-foreground">
            {formatCurrency(fiatNonUsdMarketCap, 1)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatPercent(nonCommodityShare)} of alt-peg market</p>
        </div>
      </div>
    </section>
  );
}

function AltPegDistributionCard({
  rows,
  altMarketCap,
}: {
  rows: ReturnType<typeof buildAltPegSnapshot>["distributionRows"];
  altMarketCap: number;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Current Distribution</p>
          <h2 className="pharos-section-title">Which Non-USD Pegs Matter Now</h2>
          <p className="pharos-meta">
            Ranked by current market cap, with direct links into each peg cohort page. EUR stablecoins are
            reshaped by EU MiCA rules — see the{" "}
            <Link
              href="/compliance/?regime=mica"
              className="pharos-focus-ring rounded-sm font-medium text-foreground underline-offset-2 hover:underline"
            >
              Compliance Tracker
            </Link>
            .
          </p>
        </div>
        <div className="pharos-numeric rounded-full border border-border/60 bg-muted/15 px-3 py-1.5 text-xs text-muted-foreground">
          {formatCurrency(altMarketCap, 1)} alt-peg market cap
        </div>
      </div>

      <div className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header hidden grid-cols-[minmax(0,1.35fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,0.85fr)] gap-4 md:grid">
          <span className="pharos-kicker">Peg</span>
          <span className="pharos-kicker">Market Cap</span>
          <span className="pharos-kicker">Share</span>
          <span className="pharos-kicker">Largest Coin</span>
        </div>
        <div className="divide-y divide-border/40">
          {rows.map((row) => (
            <div
              key={row.peg}
              className="grid gap-3 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1.35fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,0.85fr)] md:items-center"
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: row.colorHex }}
                  />
                  <Link
                    href={row.href}
                    className="pharos-focus-ring rounded-sm text-sm font-medium text-foreground hover:text-primary"
                  >
                    {row.label}
                  </Link>
                  <span className="pharos-numeric rounded-full border border-border/60 bg-muted/15 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {row.coinCount} coin{row.coinCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="h-2 overflow-hidden rounded-full bg-muted/30">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(row.sharePct, 2)}%`, backgroundColor: row.colorHex }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.group} cohort · {formatPercent(row.sharePct)} of alt-peg market
                  </p>
                </div>
              </div>

              <div className="space-y-1">
                <p className="pharos-kicker md:hidden">Market Cap</p>
                <p className="pharos-numeric text-sm font-semibold text-foreground">{formatCurrency(row.marketCap, 1)}</p>
              </div>

              <div className="space-y-1">
                <p className="pharos-kicker md:hidden">Share</p>
                <p className="pharos-numeric text-sm font-semibold text-foreground">{formatPercent(row.sharePct)}</p>
              </div>

              <div className="space-y-1">
                <p className="pharos-kicker md:hidden">Largest Coin</p>
                <Link
                  href={row.leaderHref}
                  className="pharos-focus-ring rounded-sm text-sm font-medium text-foreground hover:text-primary"
                >
                  {row.leaderSymbol}
                </Link>
                <p className="text-xs text-muted-foreground">{row.leaderName}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function AltPegsClient() {
  const stablecoinsQuery = useStablecoins();
  const shareQuery = useNonUsdShare();
  const pegSummaryQuery = usePegSummary();
  const dexLiquidityQuery = useDexLiquidity();
  const reportCardsQuery = useReportCardsV9();
  const logos = logosById;
  const { searchParams, pushSearchParams, replaceParams } = useUrlFilters();

  const snapshot = useMemo(
    () => buildAltPegSnapshot(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
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
    replaceParams((params) => {
      params.delete("view");
      params.delete("chart");
      params.delete("range");
    });
  }, [replaceParams]);

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

  if (stablecoinsQuery.isError || (!stablecoinsQuery.isLoading && snapshot.altCoinCount === 0)) {
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
            error: stablecoinsQuery.error,
            hasData: snapshot.altCoinCount > 0,
            meta: stablecoinsQuery.meta,
          },
          {
            label: "Non-USD Share",
            dataUpdatedAt: shareQuery.dataUpdatedAt,
            staleTime: API_FRESHNESS_MAX_AGE_SEC.nonUsdShare * 1000,
            error: shareQuery.error,
            hasData: !!shareQuery.data?.length,
          },
        ]}
      />
      <SafetyScoreV9StatusNotice response={reportCardsQuery.data} />

      {/* The celestial atlas is the sole page hero — full-width, its own chrome. */}
      <FiatWorldAtlas />

      <SectionErrorBoundary name="alt-peg-stablecoin-table">
        <AltPegStablecoinTable
          data={stablecoinsQuery.data?.peggedAssets}
          isLoading={stablecoinsQuery.isLoading}
          logos={logos}
          pegRates={tableInputs.pegRates}
          pegScores={tableInputs.pegScores}
          dexLiquidity={dexLiquidityQuery.data ?? undefined}
          reportCards={tableInputs.reportCards}
        />
      </SectionErrorBoundary>

      <AltPegMixBand
        marketCap={snapshot.altMarketCap}
        fiatNonUsdMarketCap={snapshot.fiatNonUsdMarketCap}
        commodityMarketCap={snapshot.commodityMarketCap}
      />

      <SectionErrorBoundary name="non-usd-share">
        <section id="alt-peg-history-share" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <p className="pharos-kicker">History</p>
              <h2 className="pharos-section-title">How Much Of The Total Stablecoin Market Sits Outside USD?</h2>
              <p className="pharos-meta">
                {trendStats?.yearlyMarketCapChangePct != null ? (
                  <>
                    Current outside-USD segment size is {formatSignedPercent(trendStats.yearlyMarketCapChangePct, 1)}{" "}
                    versus the nearest point one year ago.
                  </>
                ) : (
                  "This first history view tracks share of the total stablecoin market outside USD before you split the segment into individual cohorts."
                )}
              </p>
            </div>
            {snapshot.topRows[0] ? (
              <Link
                href={snapshot.topRows[0].href}
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
              >
                Largest current cohort: {snapshot.topRows[0].label}
                <ArrowRight className="h-3 w-3" />
              </Link>
            ) : null}
          </div>
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

      <AltPegDistributionCard rows={snapshot.distributionRows} altMarketCap={snapshot.altMarketCap} />
    </div>
  );
}
