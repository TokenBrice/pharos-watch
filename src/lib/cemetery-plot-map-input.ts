/**
 * What the plot-map hero receives across the server/client boundary (F5 option b3): the SAME slim register rows the
 * Autopsy Register gets (one array, deduplicated by React Flight) and a slim projection of the logo atlas manifest.
 * The client builds the plot-map model from these in a `useMemo`; the model itself never crosses the boundary.
 *
 * Client-safe: no data imports, no directive.
 */
import { toSceneAtlas, type SceneAtlas, type SceneAtlasManifest } from "@shared/lib/scene/atlas";
import type { CemeteryPlotMapInput } from "@/lib/cemetery-plot-map";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";

/** Register rows → the structural input `buildCemeteryPlotMap` accepts. Pure; keep the result memoised per `rows`. */
export function toPlotMapInput(rows: readonly CemeteryRegisterRow[]): CemeteryPlotMapInput[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    causeOfDeath: row.cause,
    deathDate: row.deathDate,
    peakMcap: row.peak ?? undefined,
    pegCurrency: row.pegCurrency,
    archivedDataAvailable: row.tracked,
  }));
}

/** The generated manifest (`cemetery-logo-atlas.generated.json`) as a JSON import types it. */
export type PlotLogoAtlasManifest = SceneAtlasManifest;

/** Serialisable logo atlas for the medallions (the scene kit's atlas): one grey cell per record. */
export type PlotLogoAtlas = SceneAtlas;

/** Narrows and slims the manifest (see {@link toSceneAtlas}). Throws on a malformed manifest. */
export const toPlotLogoAtlas = toSceneAtlas;
