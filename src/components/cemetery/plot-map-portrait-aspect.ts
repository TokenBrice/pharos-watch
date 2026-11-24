/**
 * Server-side helper exporting the portrait plan's viewBox aspect (`"w / h"`). Used by `PlotMapPortraitSlot` to lock
 * the lightweight SSR skeleton to the exact aspect of the hydrated walk (0 CLS).
 */
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";

export function getPortraitAspectRatio(rows: readonly CemeteryRegisterRow[], asOf: string): string {
  const [, , width, height] = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" }).viewBox;
  return `${width} / ${height}`;
}
