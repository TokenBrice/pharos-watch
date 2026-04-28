import type { GraveNode, PharosVilleMap, PharosVilleTile, ShipRiskPlacement, TileKind } from "./world-types";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";

export const PHAROSVILLE_MAP_WIDTH = 64;
export const PHAROSVILLE_MAP_HEIGHT = 64;

export const REGION_TILES: Record<ShipRiskPlacement, { x: number; y: number }> = {
  "safe-harbor": { x: 32, y: 36 },
  "breakwater-edge": { x: 24, y: 22 },
  "harbor-mouth-watch": { x: 44, y: 24 },
  "outer-rough-water": { x: 50, y: 44 },
  "storm-shelf": { x: 54, y: 52 },
  "data-fog": { x: 10, y: 16 },
  "ledger-mooring": { x: 36, y: 42 },
};

export const DOCK_TILES = [
  { x: 20, y: 28 },
  { x: 25, y: 21 },
  { x: 39, y: 22 },
  { x: 45, y: 35 },
  { x: 32, y: 46 },
  { x: 17, y: 38 },
  { x: 48, y: 28 },
  { x: 27, y: 48 },
];

function ellipseValue(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

export function tileKindAt(x: number, y: number): TileKind {
  const main = ellipseValue(x, y, 31.5, 31.5, 19, 15);
  const cemetery = ellipseValue(x, y, 17.5, 45, 6, 5);

  if (main < 1 || cemetery < 1) {
    if (main < 0.78 && (Math.abs(x - y) < 2 || Math.abs(x + y - 62) < 2)) return "road";
    return "land";
  }
  if (main < 1.18 || cemetery < 1.18) return "shore";
  if (x < 8 || y < 8 || x > 55 || y > 55) return "deep-water";
  return "water";
}

export function nearestWaterTile(tile: { x: number; y: number }, maxRadius = 10): { x: number; y: number } {
  const initialKind = tileKindAt(tile.x, tile.y);
  if (initialKind === "water" || initialKind === "deep-water") return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = Math.max(0, Math.min(PHAROSVILLE_MAP_WIDTH - 1, tile.x + dx));
        const y = Math.max(0, Math.min(PHAROSVILLE_MAP_HEIGHT - 1, tile.y + dy));
        const kind = tileKindAt(x, y);
        if (kind !== "water" && kind !== "deep-water") continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = { x, y };
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return tile;
}

export function nearestAvailableWaterTile(
  tile: { x: number; y: number },
  occupied: ReadonlySet<string>,
  maxRadius = 12,
): { x: number; y: number } {
  const initialKind = tileKindAt(tile.x, tile.y);
  const initialKey = `${tile.x}.${tile.y}`;
  if ((initialKind === "water" || initialKind === "deep-water") && !occupied.has(initialKey)) return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = Math.max(0, Math.min(PHAROSVILLE_MAP_WIDTH - 1, tile.x + dx));
        const y = Math.max(0, Math.min(PHAROSVILLE_MAP_HEIGHT - 1, tile.y + dy));
        if (occupied.has(`${x}.${y}`)) continue;
        const kind = tileKindAt(x, y);
        if (kind !== "water" && kind !== "deep-water") continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = { x, y };
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return nearestWaterTile(tile, maxRadius);
}

export function buildPharosVilleMap(): PharosVilleMap {
  const tiles: PharosVilleTile[] = [];
  let waterTiles = 0;
  for (let y = 0; y < PHAROSVILLE_MAP_HEIGHT; y += 1) {
    for (let x = 0; x < PHAROSVILLE_MAP_WIDTH; x += 1) {
      const kind = tileKindAt(x, y);
      if (kind === "water" || kind === "deep-water") waterTiles += 1;
      tiles.push({ x, y, kind });
    }
  }
  return {
    width: PHAROSVILLE_MAP_WIDTH,
    height: PHAROSVILLE_MAP_HEIGHT,
    tiles,
    waterRatio: waterTiles / tiles.length,
  };
}

export function graveNodesFromEntries(entries: readonly CemeteryEntry[]): GraveNode[] {
  return entries.map((entry, index) => ({
    id: `grave.${entry.id}`,
    kind: "grave",
    label: entry.symbol,
    entry,
    tile: {
      x: 14 + (index % 9),
      y: 42 + Math.floor(index / 9),
    },
    detailId: `grave.${entry.id}`,
  }));
}

export function stableOffset(id: string, span: number): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return (hash % (span * 2 + 1)) - span;
}
