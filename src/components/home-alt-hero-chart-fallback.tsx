"use client";

import { ChartSkeleton } from "@/components/chart-skeleton";

/** `settled`: the read finished without usable history, so no loading shimmer (docs/homepage.md#data-health). */
export function HomeAltHeroChartFallback({ settled = false }: { settled?: boolean }) {
  return (
    <div
      className="h-[260px] w-full p-5 sm:h-[320px] lg:h-full"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      {settled ? (
        <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border/60">
          <span className="pharos-meta">Updating</span>
        </div>
      ) : (
        <ChartSkeleton aria-hidden className="h-full w-full" />
      )}
    </div>
  );
}
