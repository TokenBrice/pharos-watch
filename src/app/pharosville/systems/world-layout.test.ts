import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { buildPharosVilleMap, graveNodesFromEntries, nearestAvailableWaterTile, nearestWaterTile, tileKindAt } from "./world-layout";

describe("buildPharosVilleMap", () => {
  it("creates a sea-first authored map", () => {
    const map = buildPharosVilleMap();

    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles).toHaveLength(64 * 64);
    expect(map.waterRatio).toBeGreaterThanOrEqual(0.83);
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

  it("scatters cemetery graves across expanded land with varied markers", () => {
    const graves = graveNodesFromEntries(CEMETERY_ENTRIES);
    const xs = graves.map((grave) => grave.tile.x);
    const ys = graves.map((grave) => grave.tile.y);

    expect(graves).toHaveLength(CEMETERY_ENTRIES.length);
    expect(graves.every((grave) => tileKindAt(grave.tile.x, grave.tile.y) === "land")).toBe(true);
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
