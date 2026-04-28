import { describe, expect, it } from "vitest";
import { buildPharosVilleMap, nearestWaterTile, tileKindAt } from "./world-layout";

describe("buildPharosVilleMap", () => {
  it("creates a sea-first authored map", () => {
    const map = buildPharosVilleMap();

    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles).toHaveLength(64 * 64);
    expect(map.waterRatio).toBeGreaterThanOrEqual(0.68);
    expect(map.waterRatio).toBeLessThanOrEqual(0.74);
  });

  it("resolves inland placement anchors back to water", () => {
    const tile = nearestWaterTile({ x: 32, y: 36 });

    expect(["water", "deep-water"]).toContain(tileKindAt(tile.x, tile.y));
  });
});
