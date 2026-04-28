import { describe, expect, it } from "vitest";
import { buildPharosVilleMap, nearestAvailableWaterTile, nearestWaterTile, tileKindAt } from "./world-layout";

describe("buildPharosVilleMap", () => {
  it("creates a sea-first authored map", () => {
    const map = buildPharosVilleMap();

    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles).toHaveLength(64 * 64);
    expect(map.waterRatio).toBeGreaterThanOrEqual(0.84);
    expect(map.waterRatio).toBeLessThanOrEqual(0.88);
  });

  it("resolves inland placement anchors back to water", () => {
    const tile = nearestWaterTile({ x: 32, y: 36 });

    expect(["water", "deep-water"]).toContain(tileKindAt(tile.x, tile.y));
  });

  it("resolves occupied placement anchors to an open nearby water tile", () => {
    const occupied = new Set(["41.46"]);
    const tile = nearestAvailableWaterTile({ x: 41, y: 46 }, occupied);

    expect(`${tile.x}.${tile.y}`).not.toBe("41.46");
    expect(["water", "deep-water"]).toContain(tileKindAt(tile.x, tile.y));
  });
});
