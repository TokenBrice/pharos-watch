import { describe, expect, it } from "vitest";
import { cameraZoomLabel, clampCameraToMap, followTile, panCamera, zoomIn, zoomOut } from "./camera";

describe("camera", () => {
  it("pans by screen-space deltas", () => {
    expect(panCamera({ offsetX: 10, offsetY: 20, zoom: 1 }, { x: 5, y: -8 })).toEqual({
      offsetX: 15,
      offsetY: 12,
      zoom: 1,
    });
  });

  it("clamps panning to the authored map bounds", () => {
    const bounds = { map: { width: 64, height: 64 }, viewport: { x: 1440, y: 1000 } };
    const camera = clampCameraToMap({ offsetX: 10_000, offsetY: -10_000, zoom: 1 }, bounds);

    expect(panCamera(camera, { x: 10_000, y: -10_000 }, bounds)).toEqual(camera);
  });

  it("zooms around viewport center", () => {
    const camera = { offsetX: 0, offsetY: 0, zoom: 1 };

    expect(zoomOut(zoomIn(camera, { x: 1000, y: 800 }), { x: 1000, y: 800 }).zoom).toBeCloseTo(1);
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
});
