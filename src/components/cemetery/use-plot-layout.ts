"use client";

import { useSceneLayout } from "../scene/use-scene-layout";

/**
 * The portrait handoff query of the plot map: phones (≤ 760 px) and touch tablets (≤ 1024 px with a coarse pointer,
 * including iPad Pro 1024×1366 portrait) get the portrait walk; mouse/fine-pointer users above 760 px and screens
 * ≥ 1025 px keep the desktop plan (CSS and the `<noscript>` fallback use this exact query).
 */
export const PLOT_PORTRAIT_QUERY = "(max-width: 760px), (max-width: 1024px) and (pointer: coarse)";

export type PlotLayout = "desktop" | "portrait";

/**
 * Which plot-map layer is live: `null` on the server and during hydration (neither layer may act yet), then
 * `"portrait"` while {@link PLOT_PORTRAIT_QUERY} matches and `"desktop"` otherwise, following viewport changes.
 */
export function usePlotLayout(): PlotLayout | null {
  const layout = useSceneLayout(PLOT_PORTRAIT_QUERY);
  return layout === null ? null : layout === "narrow" ? "portrait" : "desktop";
}
