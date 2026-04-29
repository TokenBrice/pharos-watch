import type { TilePoint } from "../systems/projection";

export type WorldDrawablePass = "underlay" | "body" | "overlay" | "selection";

export interface WorldDrawable {
  depth: number;
  detailId?: string;
  draw: (ctx: CanvasRenderingContext2D) => void;
  entityId?: string;
  kind: string;
  pass: WorldDrawablePass;
  screenBounds: { height: number; width: number; x: number; y: number };
  tieBreaker: string;
}

const DRAWABLE_PASS_RANK: Record<WorldDrawablePass, number> = {
  underlay: 0,
  body: 1,
  overlay: 2,
  selection: 3,
};

export function sortByIsoDepth<T>(
  items: readonly T[],
  tileFor: (item: T) => TilePoint,
  tieBreakerFor: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const aTile = tileFor(a);
    const bTile = tileFor(b);
    return (aTile.x + aTile.y) - (bTile.x + bTile.y)
      || aTile.y - bTile.y
      || tieBreakerFor(a).localeCompare(tieBreakerFor(b));
  });
}

export function drawableDepth(tile: TilePoint): number {
  return (tile.x + tile.y) * 1000 + tile.y;
}

export function sortWorldDrawables(drawables: readonly WorldDrawable[]): WorldDrawable[] {
  return [...drawables].sort((a, b) => (
    selectionRank(a) - selectionRank(b)
    || a.depth - b.depth
    || DRAWABLE_PASS_RANK[a.pass] - DRAWABLE_PASS_RANK[b.pass]
    || a.kind.localeCompare(b.kind)
    || a.tieBreaker.localeCompare(b.tieBreaker)
  ));
}

function selectionRank(drawable: WorldDrawable): number {
  return drawable.pass === "selection" ? 1 : 0;
}

export function drawablePassCounts(drawables: readonly WorldDrawable[]): Record<WorldDrawablePass, number> {
  return drawables.reduce<Record<WorldDrawablePass, number>>((counts, drawable) => {
    counts[drawable.pass] += 1;
    return counts;
  }, {
    underlay: 0,
    body: 0,
    overlay: 0,
    selection: 0,
  });
}
