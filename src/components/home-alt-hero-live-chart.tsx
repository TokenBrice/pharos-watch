"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { HomeAltHeroChartFallback } from "@/components/home-alt-hero-chart-fallback";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import {
  buildTotalMcapChartRows,
  TOTAL_MCAP_COHORT_IDS,
  TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS,
  type TotalMcapChartRow,
} from "@/lib/total-mcap-chart";

const HomeAltHeroChart = dynamic(
  () => import("@/components/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  {
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHeroLiveChart(): React.JSX.Element {
  const { data: chartData } = useStablecoinCharts();
  const usdtQuery = useSupplyHistory(TOTAL_MCAP_COHORT_IDS.usdt, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const usdcQuery = useSupplyHistory(TOTAL_MCAP_COHORT_IDS.usdc, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const usdsQuery = useSupplyHistory(TOTAL_MCAP_COHORT_IDS.usds, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const daiQuery = useSupplyHistory(TOTAL_MCAP_COHORT_IDS.dai, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const usdtHistory = usdtQuery.isLoading || usdtQuery.isError ? null : usdtQuery.data;
  const usdcHistory = usdcQuery.isLoading || usdcQuery.isError ? null : usdcQuery.data;
  const usdsHistory = usdsQuery.isLoading || usdsQuery.isError ? null : usdsQuery.data;
  const daiHistory = daiQuery.isLoading || daiQuery.isError ? null : daiQuery.data;

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
