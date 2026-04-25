import { describe, it, expect } from "vitest";
import { buildHarborLayer } from "./harbor-layer";
import type { SceneHarbor } from "../systems/scene-data";

function makeHarbor(id: string, name = id): SceneHarbor {
  return {
    id,
    name,
    totalUsd: 100_000_000,
    stablecoinCount: 5,
    change7dPct: 0,
    resilienceTier: 2,
    boats: [],
  };
}

describe("buildHarborLayer", () => {
  it("returns a placement per harbour, capped at the slot count", () => {
    const layer = buildHarborLayer();
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const map = layer.syncHarbors(ids.map((id) => makeHarbor(id)), 0, 0);
    // 8 slots — extra harbours are dropped
    expect(map.size).toBe(8);
    expect(layer.placements().length).toBe(8);
  });

  it("placements are anchored relative to the origin", () => {
    const layer = buildHarborLayer();
    const map = layer.syncHarbors([makeHarbor("a")], 500, 300);
    const p = map.get("a")!;
    // First slot is { tileX: 22, tileY: 12 } -> screen (22-12)*32 = 320, (22+12)*16 = 544
    expect(p.worldX).toBe(500 + 320);
    expect(p.worldY).toBe(300 + 544);
  });

  it("re-sync replaces the placement set deterministically", () => {
    const layer = buildHarborLayer();
    layer.syncHarbors([makeHarbor("a"), makeHarbor("b")], 0, 0);
    const second = layer.syncHarbors([makeHarbor("c")], 0, 0);
    expect(second.size).toBe(1);
    expect(layer.placements().length).toBe(1);
    expect(second.get("c")?.harbor.id).toBe("c");
  });
});
