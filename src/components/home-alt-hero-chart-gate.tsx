"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { HomeAltHeroChartFallback } from "@/components/home-alt-hero-chart-fallback";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { scheduleIdle } from "@/lib/browser-utils";
import type { HomepageHistory } from "@shared/types/homepage";
import { HomeAltHeroStaticChart } from "@/components/home-alt-hero-static-chart";

const HomeAltHeroLiveChart = dynamic(
  () => import("@/components/home-alt-hero-live-chart").then((mod) => mod.HomeAltHeroLiveChart),
  {
    ssr: false,
    loading: HomeAltHeroChartFallback,
  },
);

export function HomeAltHeroChartGate({ history, nowMs = 0 }: { history?: HomepageHistory; nowMs?: number }): React.JSX.Element {
  const hydrated = useHydrated();
  const { ref, near } = useNearViewport<HTMLDivElement>("0px 0px -20% 0px");
  const [active, setActive] = useState(false);

  useEffect(() => {
    // A visible chart gets an idle opportunity, not a fixed multi-second wait
    // on Safari/iOS. Two frames plus 150ms keep its work after first paint.
    if (!hydrated || !near || active) return;
    return scheduleIdle(() => setActive(true), { timeoutMs: 2_500, fallbackDelayMs: 150 });
  }, [active, hydrated, near]);

  return <div ref={ref} className="lg:absolute lg:inset-0">{active ? <HomeAltHeroLiveChart history={history} nowMs={nowMs} /> : <HomeAltHeroStaticChart history={history} nowMs={nowMs} />}</div>;
}
