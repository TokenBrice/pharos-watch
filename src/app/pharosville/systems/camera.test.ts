import { describe, expect, it } from "vitest";
import { cameraZoomLabel, clampCameraToMap, defaultCamera, followTile, panCamera, zoomIn, zoomOut } from "./camera";
import { tileToScreen } from "./projection";
import { buildPharosVilleMap, isWaterTileKind, PHAROSVILLE_MAP_HEIGHT, PHAROSVILLE_MAP_WIDTH } from "./world-layout";

describe("camera", () => {
  it("pans by screen-space deltas", () => {
    expect(panCamera({ offsetX: 10, offsetY: 20, zoom: 1 }, { x: 5, y: -8 })).toEqual({
      offsetX: 15,
      offsetY: 12,
      zoom: 1,
    });
  });

  it("clamps panning to the authored map bounds", () => {
    const bounds = { map: { width: PHAROSVILLE_MAP_WIDTH, height: PHAROSVILLE_MAP_HEIGHT }, viewport: { x: 1440, y: 1000 } };
    const camera = clampCameraToMap({ offsetX: 10_000, offsetY: -10_000, zoom: 1 }, bounds);

    expect(panCamera(camera, { x: 10_000, y: -10_000 }, bounds)).toEqual(camera);
  });

  it("zooms around viewport center", () => {
    const camera = { offsetX: 0, offsetY: 0, zoom: 1 };

    expect(zoomOut(zoomIn(camera, { x: 1000, y: 800 }), { x: 1000, y: 800 }).zoom).toBeCloseTo(1);
  });

  it("frames the authored island mass left of the extra sea margin by default", () => {
    const map = buildPharosVilleMap();
    const centerTile = landBoundsCenter(map.tiles);

    for (const viewport of [{ x: 1440, y: 1000 }, { x: 1280, y: 760 }]) {
      const camera = defaultCamera({ height: viewport.y, map, width: viewport.x });
      const center = tileToScreen(centerTile, camera);

      expect(camera.zoom).toBe(0.72);
      expect(center.x).toBeGreaterThanOrEqual(viewport.x * 0.48);
      expect(center.x).toBeLessThanOrEqual(viewport.x * 0.52);
      expect(center.y).toBeGreaterThanOrEqual(viewport.y * 0.5);
      expect(center.y).toBeLessThanOrEqual(viewport.y * 0.55);
      expect(clampCameraToMap(camera, { map, viewport })).toEqual(camera);
    }
  });

  it("keeps bounded zooms inside the biased composition frame", () => {
    const map = buildPharosVilleMap();
    const viewport = { x: 1440, y: 1000 };
    const camera = defaultCamera({ height: viewport.y, map, width: viewport.x });
    const zoomed = zoomIn(camera, viewport, map);

    expect(zoomed.zoom).toBeGreaterThan(camera.zoom);
    expect(clampCameraToMap(zoomed, { map, viewport })).toEqual(zoomed);
  });

  it("follows a tile by centering it", () => {
    const camera = followTile({
      camera: { offsetX: 0, offsetY: 0, zoom: 1 },
      tile: { x: 32, y: 32 },
      viewport: { x: 1000, y: 800 },
    });

    expect(camera.offsetX).toBe(500);
    expect(camera.offsetY).toBe(-112);
    expect(cameraZoomLabel(camera)).toBe("100%");
  });

  it("clamps follow-target framing against the biased map bounds", () => {
    const map = buildPharosVilleMap();
    const viewport = { x: 1440, y: 1000 };
    const camera = followTile({
      camera: defaultCamera({ height: viewport.y, map, width: viewport.x }),
      map,
      tile: { x: 44, y: 18 },
      viewport,
    });

    expect(clampCameraToMap(camera, { map, viewport })).toEqual(camera);
  });
});

function landBoundsCenter(tiles: Array<{ x: number; y: number; kind: string }>) {
  const landTiles = tiles.filter((tile) => !isWaterTileKind(tile.kind));
  const xs = landTiles.map((tile) => tile.x);
  const ys = landTiles.map((tile) => tile.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
