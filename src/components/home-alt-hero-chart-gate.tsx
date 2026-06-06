"use client";

import dynamic from "next/dynamic";
import { HomeAltInlineChartSkeleton } from "@/components/home-alt-inline-chart-skeleton";
import { useNearViewport } from "@/hooks/use-near-viewport";

function HomeAltHeroChartFallback() {
  return (
    <div
      className="h-[260px] w-full p-5 sm:h-[320px] lg:h-auto lg:min-h-[360px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      <HomeAltInlineChartSkeleton />
    </div>
  );
}

const HomeAltHeroLiveChart = dynamic(
  () => import("@/components/home-alt-hero-live-chart").then((mod) => mod.HomeAltHeroLiveChart),
  {
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHeroChartGate(): React.JSX.Element {
  const { ref, near } = useNearViewport<HTMLDivElement>("0px 0px -20% 0px");

  return (
    <div ref={ref}>
      {near ? <HomeAltHeroLiveChart /> : <HomeAltHeroChartFallback />}
    </div>
  );
}
