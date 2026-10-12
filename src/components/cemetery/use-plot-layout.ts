"use client";

import { useSceneLayout } from "../scene/use-scene-layout";

/** The phone breakpoint of the plot map: the portrait plan at or below it, the desktop plan above (CSS agrees). */
const PLOT_PORTRAIT_QUERY = "(max-width: 760px)";

export type PlotLayout = "desktop" | "portrait";

/**
 * Which plot-map layer is live: `null` on the server and during hydration (neither layer may act yet), then
 * `"portrait"` at ≤ 760 px and `"desktop"` above, following viewport changes.
 */
export function usePlotLayout(): PlotLayout | null {
  const layout = useSceneLayout(PLOT_PORTRAIT_QUERY);
  return layout === null ? null : layout === "narrow" ? "portrait" : "desktop";
}
