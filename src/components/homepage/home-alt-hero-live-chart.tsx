"use client";

import { useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { HomeAltHeroChartFallback } from "@/components/homepage/home-alt-hero-chart-fallback";
import { HomeAltHeroStaticChart } from "@/components/homepage/home-alt-hero-static-chart";
import { useHomepageHistory } from "@/hooks/api-hooks";
import type { HomepageHistory } from "@shared/types/homepage";
import type { TotalMcapChartRow } from "@shared/lib/total-mcap-chart";

const HomeAltHeroChart = dynamic(
  () => import("@/components/homepage/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  { loading: () => <HomeAltHeroChartFallback /> },
);

export function HomeAltHeroLiveChart({
  history,
  nowMs,
  onLiveHistoryRows,
}: {
  history?: HomepageHistory;
  nowMs: number;
  onLiveHistoryRows?: (rows: readonly TotalMcapChartRow[]) => void;
}): React.JSX.Element {
  const query = useHomepageHistory();
  // An errored history refresh is not affirmative cohort evidence. Retain the
  // independent aggregate as before, but leave all dependent overlays as gaps.
  const rows = useMemo(() => query.error
    ? (query.data?.rows ?? []).map((row) => ({ ...row, usdt: null, usdc: null, sky: null, others: null }))
    : query.data?.rows ?? [], [query.data, query.error]);

  useEffect(() => {
    if (rows.length > 0) onLiveHistoryRows?.(rows);
  }, [onLiveHistoryRows, rows]);

  // Loading, a failed first read, or a settled empty history: the dated build
  // preview, or a settled neutral placeholder.
  if (!query.data || query.data.rows.length === 0) {
    return <HomeAltHeroStaticChart history={history} nowMs={nowMs} settled={!query.isLoading} />;
  }
  return (
    <div className="h-full">
      <HomeAltHeroChart rows={rows} />
    </div>
  );
}
