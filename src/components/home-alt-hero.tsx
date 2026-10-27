"use client";

import { useEffect, useState } from "react";
import type { HomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import type { ApiMeta } from "@/lib/api";
import { CHART_ORANGE, CHART_PALETTE, CHART_SLATE_STRONG, USDT_GREEN, USDC_BLUE } from "@/lib/chart-colors";
import { HomeAltHeroChartGate } from "@/components/home-alt-hero-chart-gate";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import {
  describeHomepageSupplyCoverage,
  isHomepageSupplyComplete,
} from "@shared/lib/homepage-hero-snapshot";
import { selectHomepageHeroSnapshot } from "@/lib/homepage-hero-snapshot";
import { formatCurrency, formatLongDate } from "@shared/lib/format";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { HomeMarketStateLine } from "@/components/home-market-state-line";
import { trackFreshDataReady } from "@/lib/analytics";
import { useHomepageEvidence } from "@/lib/homepage-evidence";

// OTHERS cohort dot — violet pulled from the shared chart palette.
const OTHERS_PURPLE = CHART_PALETTE[1];

export function HomeAltHero({
  snapshot,
  fallbackSelectedAtMs,
}: {
  snapshot: HomepageHeroSnapshot;
  fallbackSelectedAtMs: number;
}): React.JSX.Element {
  const stablecoinsQuery = useHomepageSnapshot();
  // Hydration-stable first render: the build-time clock keeps server and
  // client output identical, then a deferred tick re-evaluates fallback
  // expiry with the viewer's clock (setState inside a timer callback, never
  // synchronously in the effect body).
  const [nowMs, setNowMs] = useState(fallbackSelectedAtMs);
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), 0);
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);
  const evidence = useHomepageEvidence(stablecoinsQuery.data, nowMs);
  const browserRetained = evidence.retainedLanes.includes("market");
  // Producer clocks remain lane-specific, including restored browser evidence.
  const marketMeta = evidence.data?.market.meta;
  const meta: ApiMeta = marketMeta?.updatedAt === undefined
    ? { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" }
    : marketMeta;
  const fallbackGenerationMs = snapshot.asOfISO ? Date.parse(snapshot.asOfISO) : 0;
  const liveSnapshot: HomepageHeroSnapshot | null = browserRetained && marketMeta?.updatedAt != null
    && fallbackGenerationMs > marketMeta.updatedAt * 1000
    ? null
    : evidence.data?.market.data ?? null;
  const liveHealth = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stablecoins,
    dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
    hasData: liveSnapshot !== null,
    error: stablecoinsQuery.error,
    meta,
  }, nowMs);
  const selection = selectHomepageHeroSnapshot({
    liveSnapshot, liveHealth, fallbackSnapshot: snapshot, nowMs,
  });
  useEffect(() => {
    if (selection.source === "live") trackFreshDataReady("home-hero");
  }, [selection.source]);

  const visibleSnapshot = selection.snapshot;
  const latest = visibleSnapshot?.cohort ?? null;
  const supplyComplete = !!visibleSnapshot && isHomepageSupplyComplete(visibleSnapshot);
  const cohortTotal = latest?.total ?? null;
  const selectedDate = visibleSnapshot?.asOfISO
    ? formatLongDate(new Date(visibleSnapshot.asOfISO), { utc: true })
    : null;

  return (
    <section aria-labelledby="market-pulse-title" className="space-y-4">
      <div className="space-y-1.5">
        <h1
          id="market-pulse-title"
          className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
        >
          Market Pulse
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-sm text-muted-foreground">
            Backing, freeze risk, liquidity, and peg stress — all in one place.
          </p>
          <span aria-hidden="true" className="hidden text-sm text-muted-foreground sm:inline">·</span>
          <HomeMarketStateLine nowMs={nowMs} />
        </div>
      </div>

      <div
        className="pharos-card-shell relative grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:grid-rows-[auto_1fr]"
        role="group"
        aria-label="Stablecoin market cap snapshot"
      >
        <div className="border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
          <div className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <p
                className="text-sm font-medium text-muted-foreground"
                title="Excludes 2 off-catalog PSI historical assets"
              >
                {visibleSnapshot && !supplyComplete ? "Core market cap, known subtotal" : "Core market cap"}
              </p>
              <CardExpandButton href="/screener/" expandLabel="Open Screener" className="-mr-2" />
            </div>
            <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-foreground sm:text-[2.45rem]">
              {visibleSnapshot?.totalUsd != null ? formatCurrency(visibleSnapshot.totalUsd, 1) : "—"}
            </p>
            <p className="pharos-meta min-h-4">
              {selectedDate ? `As of ${selectedDate}` : visibleSnapshot ? null : "Updating"}
            </p>
            {visibleSnapshot && !supplyComplete ? (
              <p className="pharos-meta">
                {describeHomepageSupplyCoverage(visibleSnapshot)}
              </p>
            ) : null}
          </div>
        </div>

        {/* The chart fills the whole right column at lg: the cell sizes from the
            headline + cohort column and the chart is pinned inside it. */}
        <div className="border-b border-border/50 lg:relative lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-[305px] lg:border-b-0">
          <HomeAltHeroChartGate history={snapshot.history} nowMs={nowMs} />
        </div>

        {/* Cohort breakdown — sits directly under the headline so the column
            reads as one continuous story instead of headline-then-gap-then-list. */}
        <div className="space-y-2 p-5 sm:p-6 lg:col-start-1 lg:border-r lg:border-t lg:border-border/50 lg:p-7">
          <p className="pharos-label">Market cohorts</p>
          {visibleSnapshot && !supplyComplete ? (
            <p className="text-xs text-muted-foreground">Shares of known market cap subtotal</p>
          ) : null}
          <ul className="flex min-h-[6.5rem] flex-col gap-1.5 text-xs">
            {latest ? (
              <>
                <CohortRow color={USDT_GREEN} label="USDT" value={latest.usdt} total={cohortTotal} />
                <CohortRow color={USDC_BLUE} label="USDC" value={latest.usdc} total={cohortTotal} />
                <CohortRow color={CHART_ORANGE} label="USDS + DAI" value={latest.sky} total={cohortTotal} />
                <CohortRow color={OTHERS_PURPLE} label="Others" value={latest.others} total={cohortTotal} />
                <li className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-flex h-2 w-2 items-center" aria-hidden="true">
                      <span className="w-2 border-t border-dashed" style={{ borderColor: CHART_SLATE_STRONG }} />
                    </span>
                    <span className="pharos-label">Non-USD share</span>
                  </span>
                  <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
                    {visibleSnapshot?.nonUsdUsd != null ? (
                      <>
                        <span className="text-foreground">{formatCurrency(visibleSnapshot.nonUsdUsd, 1)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{visibleSnapshot.nonUsdShare !== null ? `${(visibleSnapshot.nonUsdShare * 100).toFixed(1)}%` : "share unavailable"}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </li>
              </>
            ) : (
              <li className="pharos-label flex flex-1 items-center">
                Market data unavailable
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
function CohortRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number | null;
  total: number | null;
}): React.JSX.Element {
  const share = value != null && total != null && total > 0 ? (value / total) * 100 : null;
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="pharos-label">{label}</span>
      </span>
      <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
        {value != null ? (
          <>
            <span className="text-foreground">{formatCurrency(value, 1)}</span>
            <span aria-hidden="true">·</span>
            <span>{share != null ? `${share.toFixed(1)}%` : "—"}</span>
          </>
        ) : (
          <span title="Supply unavailable">—</span>
        )}
      </span>
    </li>
  );
}
