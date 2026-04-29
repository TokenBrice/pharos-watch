import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "../systems/pharosville-world";
import { fitCameraToMap, tileToScreen } from "../systems/projection";
import type { PharosVilleAssetManifestEntry } from "../systems/asset-manifest";
import type { ShipMotionSample } from "../systems/motion";
import type { LoadedPharosVilleAsset } from "./asset-manager";
import { collectHitTargets, hitTest } from "./hit-testing";

describe("hit-testing", () => {
  const world = buildPharosVilleWorld({
    stablecoins: fixtureStablecoins,
    chains: fixtureChains,
    stability: fixtureStability,
    pegSummary: fixturePegSummary,
    stress: fixtureStress,
    reportCards: fixtureReportCards,
    cemeteryEntries: [],
    freshness: {},
  });
  const camera = fitCameraToMap({ width: 1440, height: 1000, map: world.map });

  it("builds selectable targets for world entities", () => {
    const targets = collectHitTargets({ camera, world });

    expect(targets.some((target) => target.detailId === "lighthouse")).toBe(true);
    expect(targets.some((target) => target.kind === "ship")).toBe(true);
  });

  it("selects the top-priority target under the pointer", () => {
    const ship = world.ships[0];
    expect(ship).toBeDefined();
    const point = tileToScreen(ship!.tile, camera);
    const match = hitTest(collectHitTargets({ camera, selectedDetailId: ship!.detailId, world }), point);

    expect(match?.detailId).toBe(ship?.detailId);
  });

  it("moves ship target rectangles to sampled motion positions", () => {
    const ship = world.ships[0];
    expect(ship).toBeDefined();
    const sampledTile = { x: ship!.tile.x + 3, y: ship!.tile.y + 2 };
    const sampledPoint = tileToScreen(sampledTile, camera);
    const targets = collectHitTargets({
      camera,
      shipMotionSamples: new Map([[ship!.id, motionSample(ship!.id, sampledTile)]]),
      world,
    });
    const target = targets.find((entry) => entry.id === ship!.id);

    expect(target).toBeDefined();
    expect(target!.rect.x + target!.rect.width / 2).toBeCloseTo(sampledPoint.x);
    expect(target!.rect.y + target!.rect.height / 2).toBeCloseTo(sampledPoint.y - 16 * camera.zoom);
    expect(hitTest(targets, {
      x: target!.rect.x + target!.rect.width / 2,
      y: target!.rect.y + target!.rect.height / 2,
    })?.detailId).toBe(ship!.detailId);
  });

  it("keeps docked ships selectable while their dock is selected", () => {
    const assets = {
      get: (id: string): LoadedPharosVilleAsset | null => {
        const isDock = id.startsWith("dock.");
        const isShip = id.startsWith("ship.");
        if (!isDock && !isShip) return null;
        const entry: PharosVilleAssetManifestEntry = {
          anchor: isDock ? [48, 46] : [40, 50],
          category: isDock ? "dock" : "ship",
          displayScale: 1,
          footprint: isDock ? [42, 18] : [20, 12],
          height: 64,
          hitbox: isDock ? [8, 4, 80, 55] : [8, 8, 64, 48],
          id,
          layer: isDock ? "docks" : "ships",
          loadPriority: "critical",
          path: `${id}.png`,
          width: isDock ? 96 : 80,
        };
        return { entry, image: {} as HTMLImageElement };
      },
    };
    const usdt = world.ships.find((entry) => entry.detailId === "ship.usdt-tether");
    const ethereumDock = world.docks.find((entry) => entry.detailId === "dock.ethereum");
    expect(usdt).toBeDefined();
    expect(ethereumDock).toBeDefined();
    const targets = collectHitTargets({
      assets,
      camera,
      selectedDetailId: "dock.ethereum",
      shipMotionSamples: new Map([[usdt!.id, motionSample(usdt!.id, ethereumDock!.tile)]]),
      world,
    });
    const ship = targets.find((target) => target.detailId === "ship.usdt-tether");
    const dock = targets.find((target) => target.detailId === "dock.ethereum");
    expect(ship).toBeDefined();
    expect(dock).toBeDefined();

    const point = {
      x: ship!.rect.x + ship!.rect.width / 2,
      y: ship!.rect.y + ship!.rect.height / 2,
    };
    expect(hitTest(targets, point)?.detailId).toBe(ship!.detailId);
  });

  it("uses manifest hitboxes when sprite assets are available", () => {
    const lighthouse = world.lighthouse;
    const point = tileToScreen(lighthouse.tile, camera);
    const targets = collectHitTargets({
      assets: {
        get: (id) => id === "landmark.lighthouse"
          ? {
            entry: {
              anchor: [48, 116],
              category: "landmark",
              displayScale: 1,
              footprint: [24, 20],
              height: 128,
              hitbox: [18, 8, 60, 112],
              id,
              layer: "landmarks",
              loadPriority: "critical",
              path: "landmarks/lighthouse.png",
              width: 96,
            },
            image: {} as HTMLImageElement,
          }
          : null,
      },
      camera,
      world,
    });

    const target = targets.find((entry) => entry.detailId === lighthouse.detailId);

    expect(target?.rect.x).toBeCloseTo(point.x - 44.4 * camera.zoom);
    expect(target?.rect.y).toBeCloseTo(point.y - 156.84 * camera.zoom);
    expect(target?.rect.width).toBeCloseTo(88.8 * camera.zoom);
    expect(target?.rect.height).toBeCloseTo(165.76 * camera.zoom);
  });
});

function motionSample(shipId: string, tile: { x: number; y: number }): ShipMotionSample {
  return {
    shipId,
    tile,
    state: "sailing",
    zone: "safe",
    currentDockId: null,
    heading: { x: 1, y: 0 },
    wakeIntensity: 0.4,
  };
}
