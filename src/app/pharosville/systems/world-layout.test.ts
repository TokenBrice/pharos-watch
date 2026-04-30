import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import {
  buildPharosVilleMap,
  CEMETERY_CENTER,
  CEMETERY_RADIUS,
  CIVIC_CORE_CENTER,
  CIVIC_CORE_RADIUS,
  DOCK_TILES,
  graveNodesFromEntries,
  isElevatedTileKind,
  isLandTileKind,
  isWaterTileKind,
  LIGHTHOUSE_TILE,
  PHAROSVILLE_MAP_HEIGHT,
  PHAROSVILLE_MAP_WIDTH,
  nearestAvailableWaterTile,
  nearestWaterTile,
  REGION_TILES,
  terrainKindAt,
  tileKindAt,
} from "./world-layout";
import type { PharosVilleTile } from "./world-types";

describe("buildPharosVilleMap", () => {
  it("creates a sea-first authored map", () => {
    const map = buildPharosVilleMap();

    expect(map.width).toBe(PHAROSVILLE_MAP_WIDTH);
    expect(map.height).toBe(PHAROSVILLE_MAP_HEIGHT);
    expect(map.tiles).toHaveLength(PHAROSVILLE_MAP_WIDTH * PHAROSVILLE_MAP_HEIGHT);
    expect(map.waterRatio).toBeGreaterThanOrEqual(0.78);
    expect(map.waterRatio).toBeLessThanOrEqual(0.82);
    const bounds = landBounds(map.tiles);
    expect(bounds).toEqual({
      height: 28,
      maxX: 51,
      maxY: 44,
      minX: 18,
      minY: 17,
      width: 34,
    });
    const boundsCenter = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    expect(boundsCenter.x).toBeCloseTo(CIVIC_CORE_CENTER.x + 0.5, 1);
    expect(boundsCenter.y).toBeCloseTo(CIVIC_CORE_CENTER.y + 0.5, 1);
    const counts = terrainCounts(map.tiles);
    expect((counts.get("deep-water") ?? 0) / map.tiles.length).toBeLessThanOrEqual(0.125);
    // 0.030 floor accommodates WATCH expanding to x=0..29, converting ~27 more deep-water tiles to watch-water
    expect((counts.get("deep-water") ?? 0) / map.tiles.length).toBeGreaterThanOrEqual(0.030);
    expect(counts.get("calm-water") ?? 0).toBeGreaterThan(counts.get("watch-water") ?? 0);
    expect(counts.get("watch-water") ?? 0).toBeGreaterThan(counts.get("alert-water") ?? 0);
    expect(counts.get("alert-water") ?? 0).toBeGreaterThan(counts.get("warning-water") ?? 0);
    expect(counts.get("warning-water") ?? 0).toBeGreaterThan(counts.get("storm-water") ?? 0);
    expect(map.tiles.every((tile) => tile.terrain)).toBe(true);
    const centroid = landCentroid(map.tiles);
    expect(Math.abs(centroid.x - CIVIC_CORE_CENTER.x)).toBeLessThan(1.6);
    expect(Math.abs(centroid.y - CIVIC_CORE_CENTER.y)).toBeLessThan(1.3);
    expect([...new Set(map.tiles.map((tile) => tile.terrain))]).toEqual(expect.arrayContaining([
      "alert-water",
      "calm-water",
      "harbor-water",
      "ledger-water",
      "watch-water",
      "warning-water",
      "storm-water",
      "beach",
      "grass",
      "rock",
      "cliff",
      "hill",
    ]));
    expect([...new Set(map.tiles.map((tile) => tile.terrain))]).not.toContain("road");
  });

  it("defines a civic core around the island center", () => {
    expect(CIVIC_CORE_CENTER).toEqual({ x: 34, y: 30 });
    expect(CIVIC_CORE_RADIUS).toBe(7);
    expect(isLandTileKind(tileKindAt(CIVIC_CORE_CENTER.x, CIVIC_CORE_CENTER.y))).toBe(true);
    expect(terrainKindAt(CIVIC_CORE_CENTER.x, CIVIC_CORE_CENTER.y)).toBe("rock");
  });

  it("places the lighthouse on an elevated northeast headland clear of outer harbors", () => {
    expect(LIGHTHOUSE_TILE).toEqual({ x: 38, y: 22 });
    expect(LIGHTHOUSE_TILE.x < 28 || LIGHTHOUSE_TILE.x > 36 || LIGHTHOUSE_TILE.y < 26 || LIGHTHOUSE_TILE.y > 36).toBe(true);
    expect(isElevatedTileKind(terrainKindAt(LIGHTHOUSE_TILE.x, LIGHTHOUSE_TILE.y))).toBe(true);

    const hasWaterFacingCliff = nearbyTiles(LIGHTHOUSE_TILE, 5).some((tile) => (
      terrainKindAt(tile.x, tile.y) === "cliff"
      && cardinalNeighbors(tile).some((neighbor) => isWaterTileKind(tileKindAt(neighbor.x, neighbor.y)))
    ));
    expect(hasWaterFacingCliff).toBe(true);
  });

  it("keeps the civic core natural without road terrain", () => {
    expect(terrainKindAt(27, 35)).toBe("grass");
    expect(terrainKindAt(29, 31)).toBe("grass");
    expect(terrainKindAt(31, 29)).toBe("grass");
    expect(terrainKindAt(34, 30)).toBe("rock");
    expect(terrainKindAt(37, 30)).toBe("rock");
    expect(terrainKindAt(37, 32)).toBe("rock");
    expect(terrainKindAt(36, 26)).toBe("cliff");
    expect(terrainKindAt(41, 22)).toBe("hill");
    expect(terrainKindAt(43, 19)).toBe("cliff");
    expect(terrainKindAt(30, 28)).toBe("grass");
    expect(terrainKindAt(38, 31)).toBe("rock");
    expect(terrainKindAt(Math.round(CEMETERY_CENTER.x), Math.round(CEMETERY_CENTER.y))).toBe("grass");
  });

  it("keeps risk anchors on matching water terrain", () => {
    expect(Object.values(REGION_TILES).every((tile) => isWaterTileKind(tileKindAt(tile.x, tile.y)))).toBe(true);
    expect(terrainKindAt(REGION_TILES["safe-harbor"].x, REGION_TILES["safe-harbor"].y)).toBe("calm-water");
    expect(terrainKindAt(REGION_TILES["breakwater-edge"].x, REGION_TILES["breakwater-edge"].y)).toBe("watch-water");
    expect(terrainKindAt(REGION_TILES["harbor-mouth-watch"].x, REGION_TILES["harbor-mouth-watch"].y)).toBe("alert-water");
    expect(terrainKindAt(REGION_TILES["outer-rough-water"].x, REGION_TILES["outer-rough-water"].y)).toBe("warning-water");
    expect(terrainKindAt(REGION_TILES["storm-shelf"].x, REGION_TILES["storm-shelf"].y)).toBe("storm-water");
    expect(terrainKindAt(REGION_TILES["ledger-mooring"].x, REGION_TILES["ledger-mooring"].y)).toBe("ledger-water");
    expect(terrainKindAt(0, 0)).toBe("deep-water");
  });

  it("uses the west-edge open water for Calm Anchorage", () => {
    const westernBasinSamples = [
      { x: 0, y: 25 },
      { x: 4, y: 31 },
      { x: 8, y: 29 },
      { x: 13, y: 33 },
      { x: 16, y: 31 },
    ];

    for (const tile of westernBasinSamples) {
      expect(terrainKindAt(tile.x, tile.y), `${tile.x}.${tile.y}`).toBe("calm-water");
    }
  });

  it("keeps the south lighthouse sea lane generic water", () => {
    for (let x = 30; x <= 45; x += 1) {
      for (let y = 26; y <= 34; y += 1) {
        const terrain = terrainKindAt(x, y);
        if (!isWaterTileKind(terrain)) continue;
        expect(terrain, `${x}.${y}`).toBe("water");
      }
    }
  });

  it("keeps dock slots on coastline edges with water access", () => {
    expect(DOCK_TILES.every((tile) => !isWaterTileKind(tileKindAt(tile.x, tile.y)))).toBe(true);
    expect(DOCK_TILES.every((tile) => cardinalNeighbors(tile).some((neighbor) => (
      isWaterTileKind(tileKindAt(neighbor.x, neighbor.y))
    )))).toBe(true);
  });

  it("resolves inland placement anchors back to water", () => {
    const tile = nearestWaterTile({ x: 32, y: 36 });

    expect(isWaterTileKind(tileKindAt(tile.x, tile.y))).toBe(true);
  });

  it("resolves occupied placement anchors to an open nearby water tile", () => {
    const occupied = new Set(["37.6"]);
    const tile = nearestAvailableWaterTile({ x: 37, y: 6 }, occupied);

    expect(`${tile.x}.${tile.y}`).not.toBe("37.6");
    expect(isWaterTileKind(tileKindAt(tile.x, tile.y))).toBe(true);
  });

  it("scatters cemetery graves across expanded land with varied markers", () => {
    const graves = graveNodesFromEntries(CEMETERY_ENTRIES);
    const mainIsland = connectedLandTileKeys(LIGHTHOUSE_TILE);
    const xs = graves.map((grave) => grave.tile.x);
    const ys = graves.map((grave) => grave.tile.y);

    expect(graves).toHaveLength(CEMETERY_ENTRIES.length);
    expect(CEMETERY_CENTER).toEqual({ x: 27.0, y: 34.0 });
    expect(CEMETERY_RADIUS).toEqual({ x: 2.7, y: 1.9 });
    expect(CEMETERY_CENTER.x).toBeLessThan(CIVIC_CORE_CENTER.x);
    expect(CEMETERY_CENTER.y).toBeGreaterThan(CIVIC_CORE_CENTER.y);
    expect(CEMETERY_CENTER.x).toBeLessThan(LIGHTHOUSE_TILE.x);
    expect(tileKindAt(Math.round(CEMETERY_CENTER.x), Math.round(CEMETERY_CENTER.y))).toBe("land");
    expect(terrainKindAt(Math.round(CEMETERY_CENTER.x), Math.round(CEMETERY_CENTER.y))).toBe("grass");
    expect(tileKindAt(19, 38)).toBe("water");
    expect(graves.every((grave) => tileKindAt(grave.tile.x, grave.tile.y) === "land")).toBe(true);
    expect(mainIsland.has(tileKey({ x: Math.round(CEMETERY_CENTER.x), y: Math.round(CEMETERY_CENTER.y) }))).toBe(true);
    expect(graves.every((grave) => isNearConnectedLand(grave.tile, mainIsland))).toBe(true);
    expect(graves.every((grave) => Math.hypot(grave.tile.x - LIGHTHOUSE_TILE.x, grave.tile.y - LIGHTHOUSE_TILE.y) > 10)).toBe(true);
    expect(graves.every((grave) => DOCK_TILES.every((dock) => Math.hypot(grave.tile.x - dock.x, grave.tile.y - dock.y) > 3.25))).toBe(true);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3.5);
    expect(new Set(graves.map((grave) => grave.visual.marker)).size).toBeGreaterThan(2);
    expect(graves.filter((grave) => grave.entry.causeOfDeath === "regulatory").every((grave) => grave.visual.marker === "cross")).toBe(true);
    expect(graves.filter((grave) => grave.entry.causeOfDeath === "liquidity-drain").some((grave) => grave.visual.marker === "ledger")).toBe(true);
    expect(Math.max(...graves.map((grave) => grave.visual.scale))).toBeGreaterThan(0.42);
    expect(Math.min(...graves.map((grave) => grave.visual.scale))).toBeLessThan(0.27);
    expect(graves.reduce((sum, grave) => sum + grave.visual.scale, 0) / graves.length).toBeLessThan(0.38);
  });
});

function nearbyTiles(center: { x: number; y: number }, radius: number): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = center.y - radius; y <= center.y + radius; y += 1) {
    for (let x = center.x - radius; x <= center.x + radius; x += 1) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

function landCentroid(tiles: PharosVilleTile[]): { x: number; y: number } {
  const landTiles = tiles.filter((tile) => !isWaterTileKind(tile.kind));
  return {
    x: landTiles.reduce((sum, tile) => sum + tile.x, 0) / landTiles.length,
    y: landTiles.reduce((sum, tile) => sum + tile.y, 0) / landTiles.length,
  };
}

function landBounds(tiles: PharosVilleTile[]) {
  const landTiles = tiles.filter((tile) => !isWaterTileKind(tile.kind));
  const xs = landTiles.map((tile) => tile.x);
  const ys = landTiles.map((tile) => tile.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    height: maxY - minY + 1,
    maxX,
    maxY,
    minX,
    minY,
    width: maxX - minX + 1,
  };
}

function cardinalNeighbors(tile: { x: number; y: number }): { x: number; y: number }[] {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 },
  ];
}

function connectedLandTileKeys(start: { x: number; y: number }): Set<string> {
  const visited = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const tile = queue.shift();
    if (!tile) continue;
    if (tile.x < 0 || tile.x >= PHAROSVILLE_MAP_WIDTH || tile.y < 0 || tile.y >= PHAROSVILLE_MAP_HEIGHT) continue;
    if (isWaterTileKind(tileKindAt(tile.x, tile.y))) continue;
    const key = tileKey(tile);
    if (visited.has(key)) continue;

    visited.add(key);
    queue.push(...cardinalNeighbors(tile));
  }

  return visited;
}

function isNearConnectedLand(tile: { x: number; y: number }, connected: ReadonlySet<string>): boolean {
  return nearbyTiles({ x: Math.round(tile.x), y: Math.round(tile.y) }, 1).some((candidate) => (
    connected.has(tileKey(candidate))
    && Math.hypot(candidate.x - tile.x, candidate.y - tile.y) < 1.25
  ));
}

function tileKey(tile: { x: number; y: number }): string {
  return `${tile.x}.${tile.y}`;
}

function terrainCounts(tiles: Array<{ terrain?: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tile of tiles) {
    counts.set(String(tile.terrain), (counts.get(String(tile.terrain)) ?? 0) + 1);
  }
  return counts;
}
