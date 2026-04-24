"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { NonUsdShareChart } from "@/components/non-usd-share-chart";
import { useNonUsdShare } from "@/hooks/api-hooks";
import { TimeRangeOption, isTimeRangeOption } from "@/hooks/use-time-range-filter";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { AltPegCohortHistoryChart } from "./alt-peg-cohort-history-chart";
import { AltPegCohortDirectory } from "./fiat-world-atlas/cohort-directory";
import { FiatWorldAtlas } from "./fiat-world-atlas";
import {
  buildAltPegLinkHubGroups,
  buildAltPegSnapshot,
  buildAltPegTrendStats,
  type AltPegLinkHubItem,
} from "@/lib/alt-peg-market";
import { formatCurrency, formatPercent, formatSignedPercent } from "@shared/lib/format";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

type FocusedChart = "share" | "cohorts";

const DEFAULT_HISTORY_RANGE: TimeRangeOption = "1y";
const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();
const FIAT_LINK_HUB_ITEMS = LINK_HUB_GROUPS.find((g) => g.label === "Fiat")?.items ?? [];
const COMMODITY_INDEX_LINK_HUB_ITEMS: AltPegLinkHubItem[] = LINK_HUB_GROUPS
  .filter((g) => g.label !== "Fiat")
  .flatMap((g) => g.items);

function formatPctPointDelta(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} pts`;
}

function isFocusedChart(value: string | null): value is FocusedChart {
  return value === "share" || value === "cohorts";
}

function AltPegSnapshotHero({
  marketCap,
  sharePct,
  fiatNonUsdMarketCap,
  commodityMarketCap,
  altCoinCount,
  altPegCount,
  yearlyShareDeltaPctPoints,
}: {
  marketCap: number;
  sharePct: number;
  fiatNonUsdMarketCap: number;
  commodityMarketCap: number;
  altCoinCount: number;
  altPegCount: number;
  yearlyShareDeltaPctPoints: number | null;
}) {
  const commodityShare = marketCap > 0 ? (commodityMarketCap / marketCap) * 100 : 0;
  const nonCommodityShare = marketCap > 0 ? (fiatNonUsdMarketCap / marketCap) * 100 : 0;

  return (
    <section className="pharos-card-shell overflow-hidden">
      <div className="grid gap-6 px-4 py-4 sm:px-5 sm:py-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)] lg:items-stretch">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="pharos-kicker">Current Structure</p>
            <div className="space-y-1">
              <h2 className="text-[clamp(2rem,4vw,3.4rem)] font-black tracking-[-0.04em] text-foreground">
                {formatCurrency(marketCap, 1)}
              </h2>
              <p className="text-base font-medium text-foreground">
                {formatPercent(sharePct)} of tracked stablecoin market cap is non-USD.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3">
              <p className="pharos-kicker">1Y Share Change</p>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">
                {formatPctPointDelta(yearlyShareDeltaPctPoints)}
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3">
              <p className="pharos-kicker">Tracked Coins</p>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">{altCoinCount}</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3">
              <p className="pharos-kicker">Active Peg Cohorts</p>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">{altPegCount}</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-[1.35rem] border border-border/60 bg-muted/12 p-4">
          <div className="space-y-1">
            <p className="pharos-kicker">All Alt-Peg Mix</p>
            <p className="text-sm text-muted-foreground">Commodities vs. all other non-USD pegs.</p>
          </div>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/35">
            <div className="h-full bg-[color:var(--chart-5)]" style={{ width: `${commodityShare}%` }} />
            <div className="h-full bg-[color:var(--brand-accent)]" style={{ width: `${nonCommodityShare}%` }} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/50 bg-background/45 px-3 py-3">
              <p className="pharos-kicker flex items-center gap-2 text-[color:var(--chart-5)]">
                <span className="size-2 rounded-full bg-[color:var(--chart-5)]" aria-hidden="true" />
                Commodities
              </p>
              <p className="mt-1 font-mono text-base font-semibold text-foreground">
                {formatCurrency(commodityMarketCap, 1)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{formatPercent(commodityShare)} of alt-peg market</p>
            </div>
            <div className="rounded-xl border border-border/50 bg-background/45 px-3 py-3">
              <p className="pharos-kicker flex items-center gap-2 text-[color:var(--brand-accent)]">
                <span className="size-2 rounded-full bg-[color:var(--brand-accent)]" aria-hidden="true" />
                Non-commodity Non-USD
              </p>
              <p className="mt-1 font-mono text-base font-semibold text-foreground">
                {formatCurrency(fiatNonUsdMarketCap, 1)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{formatPercent(nonCommodityShare)} of alt-peg market</p>
            </div>
          </div>
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
            Ranked by current market cap, with direct links into each peg cohort page.
          </p>
        </div>
        <div className="rounded-full border border-border/60 bg-muted/15 px-3 py-1.5 font-mono text-xs text-muted-foreground">
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
                  <span className="rounded-full border border-border/60 bg-muted/15 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
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
                <p className="font-mono text-sm font-semibold text-foreground">{formatCurrency(row.marketCap, 1)}</p>
              </div>

              <div className="space-y-1">
                <p className="pharos-kicker md:hidden">Share</p>
                <p className="font-mono text-sm font-semibold text-foreground">{formatPercent(row.sharePct)}</p>
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
  const { searchParams, pushSearchParams, replaceParams } = useUrlFilters();

  const snapshot = useMemo(
    () => buildAltPegSnapshot(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
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
    <div className="space-y-6 animate-in fade-in duration-300">
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

      <AltPegSnapshotHero
        marketCap={snapshot.altMarketCap}
        sharePct={snapshot.altSharePct}
        fiatNonUsdMarketCap={snapshot.fiatNonUsdMarketCap}
        commodityMarketCap={snapshot.commodityMarketCap}
        altCoinCount={snapshot.altCoinCount}
        altPegCount={snapshot.altPegCount}
        yearlyShareDeltaPctPoints={trendStats?.yearlyShareDeltaPctPoints ?? null}
      />

      <FiatWorldAtlas
        fiatItems={FIAT_LINK_HUB_ITEMS}
        commodityIndexItems={COMMODITY_INDEX_LINK_HUB_ITEMS}
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

      <AltPegCohortDirectory
        fiatItems={FIAT_LINK_HUB_ITEMS}
        commodityIndexItems={COMMODITY_INDEX_LINK_HUB_ITEMS}
      />

      <AltPegDistributionCard rows={snapshot.distributionRows} altMarketCap={snapshot.altMarketCap} />
    </div>
  );
}
