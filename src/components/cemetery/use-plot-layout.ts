"use client";

import { useSyncExternalStore } from "react";

/** The phone breakpoint of the plot map: the portrait plan at or below it, the desktop plan above (CSS agrees). */
export const PLOT_PORTRAIT_QUERY = "(max-width: 760px)";

export type PlotLayout = "desktop" | "portrait";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PLOT_PORTRAIT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): PlotLayout {
  return window.matchMedia(PLOT_PORTRAIT_QUERY).matches ? "portrait" : "desktop";
}

function getServerSnapshot(): null {
  return null;
}

/**
 * Which plot-map layer is live: `null` on the server and during hydration (neither layer may act yet), then
 * `"portrait"` at ≤ 760 px and `"desktop"` above, following viewport changes.
 */
export function usePlotLayout(): PlotLayout | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
