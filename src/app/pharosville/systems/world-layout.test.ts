import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import {
  buildPharosVilleMap,
  DOCK_TILES,
  graveNodesFromEntries,
  isElevatedTileKind,
  isWaterTileKind,
  LIGHTHOUSE_TILE,
  nearestAvailableWaterTile,
  nearestWaterTile,
  REGION_TILES,
  terrainKindAt,
  tileKindAt,
} from "./world-layout";

describe("buildPharosVilleMap", () => {
  it("creates a sea-first authored map", () => {
    const map = buildPharosVilleMap();

    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles).toHaveLength(64 * 64);
    expect(map.waterRatio).toBeGreaterThanOrEqual(0.76);
    expect(map.waterRatio).toBeLessThanOrEqual(0.84);
    expect(map.tiles.every((tile) => tile.terrain)).toBe(true);
    expect([...new Set(map.tiles.map((tile) => tile.terrain))]).toEqual(expect.arrayContaining([
      "harbor-water",
      "fog-water",
      "storm-water",
      "beach",
      "grass",
      "rock",
      "cliff",
      "hill",
      "road",
    ]));
  });

  it("places the lighthouse on an elevated northeast headland with a road and water-facing cliff", () => {
    expect(LIGHTHOUSE_TILE).toEqual({ x: 44, y: 18 });
    expect(LIGHTHOUSE_TILE.x < 28 || LIGHTHOUSE_TILE.x > 36 || LIGHTHOUSE_TILE.y < 26 || LIGHTHOUSE_TILE.y > 36).toBe(true);
    expect(isElevatedTileKind(terrainKindAt(LIGHTHOUSE_TILE.x, LIGHTHOUSE_TILE.y))).toBe(true);
    expect(terrainKindAt(43, 19)).toBe("road");

    const hasWaterFacingCliff = nearbyTiles(LIGHTHOUSE_TILE, 5).some((tile) => (
      terrainKindAt(tile.x, tile.y) === "cliff"
      && cardinalNeighbors(tile).some((neighbor) => isWaterTileKind(tileKindAt(neighbor.x, neighbor.y)))
    ));
    expect(hasWaterFacingCliff).toBe(true);
  });

  it("keeps risk and fog anchors on matching water terrain", () => {
    expect(terrainKindAt(REGION_TILES["storm-shelf"].x, REGION_TILES["storm-shelf"].y)).toBe("storm-water");
    expect(terrainKindAt(REGION_TILES["data-fog"].x, REGION_TILES["data-fog"].y)).toBe("fog-water");
  });

  it("keeps harbor docks on cove edges with water access", () => {
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
    const occupied = new Set(["41.46"]);
    const tile = nearestAvailableWaterTile({ x: 41, y: 46 }, occupied);

    expect(`${tile.x}.${tile.y}`).not.toBe("41.46");
    expect(isWaterTileKind(tileKindAt(tile.x, tile.y))).toBe(true);
  });

  it("scatters cemetery graves across expanded land with varied markers", () => {
    const graves = graveNodesFromEntries(CEMETERY_ENTRIES);
    const xs = graves.map((grave) => grave.tile.x);
    const ys = graves.map((grave) => grave.tile.y);

    expect(graves).toHaveLength(CEMETERY_ENTRIES.length);
    expect(graves.every((grave) => tileKindAt(grave.tile.x, grave.tile.y) === "land")).toBe(true);
    expect(graves.every((grave) => Math.hypot(grave.tile.x - LIGHTHOUSE_TILE.x, grave.tile.y - LIGHTHOUSE_TILE.y) > 24)).toBe(true);
    expect(graves.every((grave) => DOCK_TILES.every((dock) => Math.hypot(grave.tile.x - dock.x, grave.tile.y - dock.y) > 4))).toBe(true);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(6.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
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

function cardinalNeighbors(tile: { x: number; y: number }): { x: number; y: number }[] {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 },
  ];
}
