"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { HomeAltHeroChartFallback } from "@/components/home-alt-hero-chart-fallback";
import { HomeAltHeroStaticChart } from "@/components/home-alt-hero-static-chart";
import { useHomepageHistory } from "@/hooks/api-hooks";
import type { HomepageHistory } from "@shared/types/homepage";
import { deriveDataHealth } from "@/lib/data-health";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

const HomeAltHeroChart = dynamic(
  () => import("@/components/home-alt-hero-chart").then((mod) => mod.HomeAltHeroChart),
  { loading: HomeAltHeroChartFallback },
);

export function HomeAltHeroLiveChart({ history, nowMs }: { history?: HomepageHistory; nowMs: number }): React.JSX.Element {
  const query = useHomepageHistory();
  // An errored history refresh is not affirmative cohort evidence. Retain the
  // independent aggregate as before, but leave all dependent overlays as gaps.
  const rows = useMemo(() => query.error
    ? (query.data?.rows ?? []).map((row) => ({ ...row, usdt: null, usdc: null, sky: null, others: null }))
    : query.data?.rows ?? [], [query.data, query.error]);
  const sourceNotices = query.data ? Object.entries(query.data.sources).flatMap(([name, source]) => {
    const health = deriveDataHealth({
      label: name,
      staleTime: (name === "total" ? API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts : API_FRESHNESS_MAX_AGE_SEC.supplyHistory) * 1000,
      hasData: source.updatedAt !== null, dataUpdatedAt: query.dataUpdatedAt, meta: source, error: query.error,
    }, nowMs);
    return health.state === "fresh" ? [] : [`${name} ${health.state} (${source.reason ?? "aged-generation"})`];
  }) : [];
  if (query.isLoading && !query.data) return <HomeAltHeroStaticChart history={history} nowMs={nowMs} />;
  return (
    <div className="h-full">
      <HomeAltHeroChart rows={rows} isLoadingHistory={query.isLoading} />
      {query.error ? <p className="pharos-meta px-5">History refresh failed · <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p> : null}
      {sourceNotices.length > 0 ? <p className="pharos-meta px-5">History sources: {sourceNotices.join(" · ")}</p> : null}
    </div>
  );
}
