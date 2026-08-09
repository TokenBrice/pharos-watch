"use client";

import { ChartSkeleton } from "@/components/chart-skeleton";

export function HomeAltHeroChartFallback() {
  return (
    <div
      className="h-[260px] w-full p-5 sm:h-[320px] lg:h-auto lg:min-h-[305px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      <ChartSkeleton aria-hidden className="h-full w-full" />
    </div>
  );
}
