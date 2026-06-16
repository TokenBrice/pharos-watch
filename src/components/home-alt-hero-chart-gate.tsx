"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { HomeAltInlineChartSkeleton } from "@/components/home-alt-inline-chart-skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { scheduleIdle } from "@/lib/browser-utils";

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
    ssr: false,
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHeroChartGate(): React.JSX.Element {
  const hydrated = useHydrated();
  const { ref, near } = useNearViewport<HTMLDivElement>("0px 0px -20% 0px");
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Wait for hydration to settle before scheduling the chart mount so its
    // ~208KB of data fetches stay off the initial-load critical path.
    if (!hydrated || !near || active) return;
    return scheduleIdle(() => setActive(true), 2_500);
  }, [active, hydrated, near]);

  return (
    <div ref={ref}>
      {active ? <HomeAltHeroLiveChart /> : <HomeAltHeroChartFallback />}
    </div>
  );
}
