"use client";

import { useEffect, useMemo, useState } from "react";
import type { HomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import { CHART_ORANGE, CHART_PALETTE, CHART_SLATE_STRONG, USDT_GREEN, USDC_BLUE } from "@/lib/chart-colors";
import { HomeAltHeroChartGate } from "@/components/home-alt-hero-chart-gate";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
import { useStablecoins } from "@/hooks/use-stablecoins";
import {
  buildLiveHomepageHeroSnapshot,
  selectHomepageHeroSnapshot,
} from "@/lib/homepage-hero-snapshot";
import { formatCurrency, formatLongDate } from "@shared/lib/format";

// OTHERS cohort dot — violet pulled from the shared chart palette.
const OTHERS_PURPLE = CHART_PALETTE[1];

export function HomeAltHero({
  snapshot,
  fallbackSelectedAtMs,
}: {
  snapshot: HomepageHeroSnapshot;
  fallbackSelectedAtMs: number;
}): React.JSX.Element {
  const stablecoinsQuery = useStablecoins();
  const liveSnapshot = useMemo(
    () => stablecoinsQuery.data
      ? buildLiveHomepageHeroSnapshot(stablecoinsQuery.data, stablecoinsQuery.meta?.updatedAt)
      : null,
    [stablecoinsQuery.data, stablecoinsQuery.meta?.updatedAt],
  );
  // Hydration-stable first render: the build-time clock keeps server and
  // client output identical, then a deferred tick re-evaluates fallback
  // expiry with the viewer's clock (setState inside a timer callback, never
  // synchronously in the effect body).
  const [nowMs, setNowMs] = useState(fallbackSelectedAtMs);
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), 0);
    return () => clearTimeout(timer);
  }, []);
  const selection = useMemo(
    () => selectHomepageHeroSnapshot({ liveSnapshot, fallbackSnapshot: snapshot, nowMs }),
    [liveSnapshot, snapshot, nowMs],
  );

  const visibleSnapshot = selection.snapshot;
  const latest = visibleSnapshot?.cohort ?? null;
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
        <p className="text-sm text-muted-foreground">
          Backing, freeze risk, liquidity, and peg stress — all in one place.
        </p>
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
                title="Excludes 2 shadow assets used only for PSI continuity"
              >
                Total Market Cap
              </p>
              <CardExpandButton href="/screener/" expandLabel="Open Screener" className="-mr-2" />
            </div>
            <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
              {visibleSnapshot ? formatCurrency(visibleSnapshot.totalUsd, 1) : "—"}
            </p>
            <p className="min-h-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {selection.source === "fallback" && selectedDate
                ? `Fallback · as of ${selectedDate}`
                : selection.source === "live"
                  ? selectedDate
                    ? `Live · as of ${selectedDate}`
                    : "Live stablecoin data"
                  : "Live market data unavailable"}
            </p>
          </div>
        </div>

        <div className="border-b border-border/50 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-b-0">
          <HomeAltHeroChartGate />
        </div>

        {/* Cohort breakdown — sits directly under the headline so the column
            reads as one continuous story instead of headline-then-gap-then-list. */}
        <div className="space-y-2 p-5 sm:p-6 lg:col-start-1 lg:border-r lg:border-t lg:border-border/50 lg:p-7">
          <p className="pharos-kicker">Market Cohorts</p>
          <ul className="flex min-h-[6.5rem] flex-col gap-1.5 text-xs">
            {latest ? (
              <>
                <CohortRow color={USDT_GREEN} label="USDT" value={latest.usdt} total={latest.total} />
                <CohortRow color={USDC_BLUE} label="USDC" value={latest.usdc} total={latest.total} />
                <CohortRow color={CHART_ORANGE} label="USDS + DAI" value={latest.sky} total={latest.total} />
                <CohortRow color={OTHERS_PURPLE} label="Others" value={latest.others} total={latest.total} />
                <li className="flex items-baseline justify-between gap-3 pharos-numeric">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-flex h-2 w-2 items-center" aria-hidden="true">
                      <span className="w-2 border-t border-dashed" style={{ borderColor: CHART_SLATE_STRONG }} />
                    </span>
                    <span className="uppercase tracking-tight">Non-USD share</span>
                  </span>
                  <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
                    {visibleSnapshot && visibleSnapshot.nonUsdShare !== null ? (
                      <>
                        <span className="text-foreground">{formatCurrency(visibleSnapshot.nonUsdUsd, 1)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{(visibleSnapshot.nonUsdShare * 100).toFixed(1)}%</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </li>
              </>
            ) : (
              <li className="flex flex-1 items-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
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
  value: number;
  total: number;
}): React.JSX.Element {
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <li className="flex items-baseline justify-between gap-3 pharos-numeric">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="uppercase tracking-tight">{label}</span>
      </span>
      <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
        <span className="text-foreground">{formatCurrency(value, 1)}</span>
        <span aria-hidden="true">·</span>
        <span>{share.toFixed(1)}%</span>
      </span>
    </li>
  );
}
