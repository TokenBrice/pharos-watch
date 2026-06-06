"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useStablecoins, useSupplyHistory } from "@/hooks/use-stablecoins";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { selectVisibleMcap } from "@/lib/home-alt-aggregates";
import {
  buildTotalMcapChartRows,
  TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS,
} from "@/lib/total-mcap-chart";
import { CHART_SLATE, USDT_GREEN, USDC_BLUE, SKY_YELLOW } from "@/lib/chart-colors";
import { formatCurrency, getNetColor } from "@shared/lib/format";

function HomeAltInlineChartSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`pharos-chart-stage skeleton-shimmer relative w-full overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="absolute bottom-8 left-3 top-3 flex w-8 flex-col justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-2.5 w-full rounded bg-muted/50" />
        ))}
      </div>
      <div className="absolute bottom-2 left-12 right-3 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-2 w-8 rounded bg-muted/50" />
        ))}
      </div>
      <svg
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        viewBox="0 0 400 100"
      >
        <path
          d="M 40 80 C 80 75, 120 60, 160 65 C 200 70, 240 40, 280 45 C 320 50, 360 30, 400 35 L 400 100 L 40 100 Z"
          fill="currentColor"
          className="text-muted/20"
        />
      </svg>
    </div>
  );
}

function HomeAltHeroChartFallback() {
  return (
    <div
      className="h-[260px] w-full p-5 sm:h-[320px] lg:h-auto lg:min-h-[360px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      <HomeAltInlineChartSkeleton className="h-full" />
    </div>
  );
}

const HomeAltHeroChart = dynamic(
  () => import("@/components/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  {
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHero(): React.JSX.Element {
  const { data: stablecoins } = useStablecoins();
  const { data: chartData } = useStablecoinCharts();
  const { data: usdtHistory } = useSupplyHistory("usdt-tether", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdcHistory } = useSupplyHistory("usdc-circle", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdsHistory } = useSupplyHistory("usds-sky", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: daiHistory } = useSupplyHistory("dai-makerdao", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);

  const mcap = useMemo(() => selectVisibleMcap(stablecoins?.peggedAssets), [stablecoins]);
  const change24hPct = mcap.change24hPct === null ? null : mcap.change24hPct * 100;

  const rows = useMemo(() => {
    if (!Array.isArray(chartData) || chartData.length === 0) return [];
    return buildTotalMcapChartRows(chartData, {
      usdtHistory,
      usdcHistory,
      usdsHistory,
      daiHistory,
    });
  }, [chartData, daiHistory, usdcHistory, usdsHistory, usdtHistory]);

  const latest = rows.length > 0 ? rows[rows.length - 1] : null;

  return (
    <section
      className="pharos-card-shell grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]"
      aria-label="Stablecoin market cap snapshot"
    >
      <div className="flex flex-col gap-6 border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
        <div className="space-y-2.5">
          <p
            className="pharos-kicker"
            title="Excludes 2 shadow assets used only for PSI continuity"
          >
            Total Stablecoin Market Cap
          </p>
          <p
            className="font-mono font-semibold leading-[0.92] tracking-tight tabular-nums text-foreground"
            style={{ fontSize: "clamp(2.5rem, 5.5vw, 4.75rem)" }}
          >
            {formatCurrency(mcap.totalUsd, 1)}
          </p>
          {change24hPct !== null ? (
            <p
              className={`font-mono text-sm tabular-nums ${getNetColor(change24hPct)}`}
            >
              <span aria-hidden="true">{change24hPct >= 0 ? "↑" : "↓"}</span>{" "}
              <span>{`${change24hPct >= 0 ? "+" : ""}${change24hPct.toFixed(2)}%`}</span>
              <span className="ml-1 text-muted-foreground">24h</span>
            </p>
          ) : null}
        </div>

        {/* Cohort breakdown — sits directly under the headline so the column
            reads as one continuous story instead of headline-then-gap-then-list. */}
        <div className="space-y-2 border-t border-border/50 pt-5">
          <p className="pharos-kicker">Market Cohorts</p>
          <ul className="flex flex-col gap-1.5 text-xs">
            {latest ? (
              <>
                <CohortRow color={USDT_GREEN} label="USDT" value={latest.usdt} total={latest.total} />
                <CohortRow color={USDC_BLUE} label="USDC" value={latest.usdc} total={latest.total} />
                <CohortRow color={SKY_YELLOW} label="USDS + DAI" value={latest.sky} total={latest.total} />
                <CohortRow color={CHART_SLATE} label="Others" value={latest.others} total={latest.total} />
                <li className="flex items-baseline justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
                  <span className="font-mono uppercase tracking-wider">Non-USD share</span>
                  <span className="font-mono tabular-nums text-foreground/90">
                    {mcap.nonUsdShare !== null
                      ? `${formatCurrency(mcap.nonUsdUsd, 1)} · ${(mcap.nonUsdShare * 100).toFixed(1)}%`
                      : "—"}
                  </span>
                </li>
              </>
            ) : (
              <li className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Loading cohorts…
              </li>
            )}
          </ul>
        </div>
      </div>

      <HomeAltHeroChart rows={rows} />
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
    <li className="flex items-baseline justify-between gap-3 font-mono">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="uppercase tracking-tight">{label}</span>
      </span>
      <span className="flex items-baseline gap-2 tabular-nums">
        <span className="text-foreground">{formatCurrency(value, 1)}</span>
        <span className="w-12 text-right text-muted-foreground">{share.toFixed(1)}%</span>
      </span>
    </li>
  );
}
