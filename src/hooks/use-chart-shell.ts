"use client";

import { useCallback, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";

export function useChartShell<T extends HTMLElement>() {
  const reducedMotion = usePrefersReducedMotion({ ssrDefault: true });
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<T>();

  return {
    animProps: shouldAnimate && !reducedMotion ? CHART_DRAW_IN : CHART_NO_ANIM,
    handleAnimationEnd,
    chartContainerRef,
    isChartReady,
    width,
    height,
  };
}
