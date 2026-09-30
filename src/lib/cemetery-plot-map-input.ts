/**
 * What the plot-map hero receives across the server/client boundary (F5 option b3): the SAME slim register rows the
 * Autopsy Register gets (one array, deduplicated by React Flight) and a slim projection of the logo atlas manifest.
 * The client builds the plot-map model from these in a `useMemo`; the model itself never crosses the boundary.
 *
 * Client-safe: type-only imports, no data imports, no directive.
 */
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
export interface PlotLogoAtlasManifest {
  readonly revision: string;
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
  readonly image: string;
  readonly entries: Readonly<Record<string, { readonly color: readonly number[]; readonly gray: readonly number[] }>>;
}

/** Serialisable logo atlas for the medallions: one grey cell per record; the colour cell sits `shift` px to its left. */
export interface PlotLogoAtlas {
  /** Atlas image URL, cache-busted by the manifest revision. */
  href: string;
  width: number;
  height: number;
  cellSize: number;
  /** Grey cell x − colour cell x (same row for every record): the hot/pinned medallion slides the image by this. */
  shift: number;
  /** Grey cell origin by record id; records without a logo are absent (the medallion shows an initial). */
  cells: Readonly<Record<string, readonly [number, number]>>;
}

/**
 * Narrows and slims the manifest: every cell must be an `[x, y]` pair and every colour cell must sit at one shared
 * horizontal offset from its grey cell (the CSS-only colour swap depends on it). Throws on a malformed manifest.
 */
export function toPlotLogoAtlas(manifest: PlotLogoAtlasManifest): PlotLogoAtlas {
  let shift: number | null = null;
  const cells: Record<string, readonly [number, number]> = {};
  for (const [id, { color, gray }] of Object.entries(manifest.entries)) {
    if (color.length !== 2 || gray.length !== 2) throw new Error(`Logo atlas cell for ${id} is not an [x, y] pair`);
    const offset = gray[0] - color[0];
    if (gray[1] !== color[1] || (shift !== null && offset !== shift)) {
      throw new Error(`Logo atlas colour cell for ${id} is not at the shared offset from its grey cell`);
    }
    shift = offset;
    cells[id] = [gray[0], gray[1]];
  }
  return {
    href: `${manifest.image}?v=${manifest.revision}`,
    width: manifest.width,
    height: manifest.height,
    cellSize: manifest.cellSize,
    shift: shift ?? 0,
    cells,
  };
}
