/**
 * Server-side helper for the portrait slot's reserved box: the portrait plan's viewBox aspect (`"w / h"`), so the
 * slot holds the plan's height before the client mounts it (CLS). Pure and deterministic; lives outside the
 * `"use client"` slot module so a Server Component can call it.
 */
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";

export function getPortraitAspectRatio(rows: readonly CemeteryRegisterRow[], asOf: string): string {
  const [, , width, height] = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" }).viewBox;
  return `${width} / ${height}`;
}
