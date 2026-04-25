import { describe, it, expect } from "vitest";
import { TILE_W, TILE_H, worldToScreen, screenToWorld, depthKey } from "./isometric";

describe("isometric projection", () => {
  it("origin maps to origin", () => {
    expect(worldToScreen({ tileX: 0, tileY: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("east tile maps right and down", () => {
    expect(worldToScreen({ tileX: 1, tileY: 0 })).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
  });

  it("south tile maps left and down", () => {
    expect(worldToScreen({ tileX: 0, tileY: 1 })).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
  });

  it.each([
    [0, 0], [3, 5], [10, 0], [0, 10], [-2, 7],
  ])("screenToWorld inverts worldToScreen for (%i, %i)", (tx, ty) => {
    const s = worldToScreen({ tileX: tx, tileY: ty });
    const w = screenToWorld(s);
    expect(w.tileX).toBeCloseTo(tx, 6);
    expect(w.tileY).toBeCloseTo(ty, 6);
  });

  it("depthKey orders south-east tiles after north-west", () => {
    const a = depthKey({ tileX: 1, tileY: 1, elevation: 0 });
    const b = depthKey({ tileX: 4, tileY: 4, elevation: 0 });
    expect(b).toBeGreaterThan(a);
  });

  it("elevated tile beats any non-elevated tile in the same column", () => {
    const ground = depthKey({ tileX: 30, tileY: 30, elevation: 0 });
    const elevated = depthKey({ tileX: 1, tileY: 1, elevation: 1 });
    expect(elevated).toBeGreaterThan(ground);
  });
});
