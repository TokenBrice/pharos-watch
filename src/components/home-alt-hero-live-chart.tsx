"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { HomeAltHeroChartFallback } from "@/components/home-alt-hero-chart-fallback";
import { HomeAltHeroStaticChart } from "@/components/home-alt-hero-static-chart";
import { useHomepageHistory } from "@/hooks/api-hooks";
import type { HomepageHistory } from "@shared/types/homepage";

const HomeAltHeroChart = dynamic(
  () => import("@/components/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  { loading: () => <HomeAltHeroChartFallback /> },
);

export function HomeAltHeroLiveChart({ history, nowMs }: { history?: HomepageHistory; nowMs: number }): React.JSX.Element {
  const query = useHomepageHistory();
  // An errored history refresh is not affirmative cohort evidence. Retain the
  // independent aggregate as before, but leave all dependent overlays as gaps.
  const rows = useMemo(() => query.error
    ? (query.data?.rows ?? []).map((row) => ({ ...row, usdt: null, usdc: null, sky: null, others: null }))
    : query.data?.rows ?? [], [query.data, query.error]);
  // Loading or a failed first read: the dated build preview, or a settled neutral placeholder.
  if (!query.data) return <HomeAltHeroStaticChart history={history} nowMs={nowMs} settled={!query.isLoading} />;
  return (
    <div className="h-full">
      <HomeAltHeroChart rows={rows} isLoadingHistory={query.isLoading} />
    </div>
  );
}
