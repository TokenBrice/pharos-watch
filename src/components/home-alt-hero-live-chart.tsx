"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { HomeAltInlineChartSkeleton } from "@/components/home-alt-inline-chart-skeleton";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import {
  buildTotalMcapChartRows,
  TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS,
  type TotalMcapChartRow,
} from "@/lib/total-mcap-chart";

function HomeAltHeroChartFallback() {
  return (
    <div
      className="h-[260px] w-full p-5 sm:h-[320px] lg:h-auto lg:min-h-[360px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      <HomeAltInlineChartSkeleton className="h-full w-full" />
    </div>
  );
}

const HomeAltHeroChart = dynamic(
  () => import("@/components/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  {
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHeroLiveChart(): React.JSX.Element {
  const { data: chartData } = useStablecoinCharts();
  const { data: usdtHistory } = useSupplyHistory("usdt-tether", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdcHistory } = useSupplyHistory("usdc-circle", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdsHistory } = useSupplyHistory("usds-sky", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: daiHistory } = useSupplyHistory("dai-makerdao", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);

  const rows = useMemo<TotalMcapChartRow[]>(() => {
    if (!Array.isArray(chartData) || chartData.length === 0) return [];
    return buildTotalMcapChartRows(chartData, {
      usdtHistory,
      usdcHistory,
      usdsHistory,
      daiHistory,
    });
  }, [chartData, daiHistory, usdcHistory, usdsHistory, usdtHistory]);

  return <HomeAltHeroChart rows={rows} />;
}
