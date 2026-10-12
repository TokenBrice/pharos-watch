/**
 * Scene kit logo atlas: the slim, serialisable projection of a generated atlas manifest
 * (`scripts/lib/scene-atlas.ts` writes the manifest and the WebP). Every logo is a pair of cells in one atlas row,
 * full colour then grey, at one shared horizontal offset, so a CSS-only colour swap slides the image by `shift`.
 *
 * Pure; the manifest arrives as data (a JSON import on the server side), never bundled into a client component.
 */

/** A generated manifest as a JSON import types it. */
export interface SceneAtlasManifest {
  readonly revision: string;
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
  readonly image: string;
  readonly entries: Readonly<Record<string, { readonly color: readonly number[]; readonly gray: readonly number[] }>>;
}

/** Serialisable logo atlas: one grey cell per id; the colour cell sits `shift` px to its left. */
export interface SceneAtlas {
  /** Atlas image URL, cache-busted by the manifest revision. */
  href: string;
  width: number;
  height: number;
  cellSize: number;
  /** Grey cell x − colour cell x (same row for every id): a coloured state slides the image by this. */
  shift: number;
  /** Grey cell origin by id; ids without a logo are absent (the scene shows a fallback). */
  cells: Readonly<Record<string, readonly [number, number]>>;
}

/**
 * Narrows and slims the manifest: every cell must be an `[x, y]` pair and every colour cell must sit at one shared
 * horizontal offset from its grey cell (the CSS-only colour swap depends on it). Throws on a malformed manifest.
 */
export function toSceneAtlas(manifest: SceneAtlasManifest): SceneAtlas {
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
