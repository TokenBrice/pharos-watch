import type { TilePoint } from "../systems/projection";

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
