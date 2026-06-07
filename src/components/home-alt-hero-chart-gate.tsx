"use client";

import { useEffect, useState } from "react";
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
    ssr: false,
    loading: HomeAltHeroChartFallback,
  },
);

function scheduleIdle(callback: () => void): () => void {
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(callback, { timeout: 2_500 });
    return () => win.cancelIdleCallback?.(handle);
  }

  const timeout = window.setTimeout(callback, 1_800);
  return () => window.clearTimeout(timeout);
}

export function HomeAltHeroChartGate(): React.JSX.Element {
  const { ref, near } = useNearViewport<HTMLDivElement>("0px 0px -20% 0px");
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!near || active) return;
    return scheduleIdle(() => setActive(true));
  }, [active, near]);

  return (
    <div ref={ref}>
      {active ? <HomeAltHeroLiveChart /> : <HomeAltHeroChartFallback />}
    </div>
  );
}
