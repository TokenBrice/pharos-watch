import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "../systems/pharosville-world";
import { defaultCamera } from "../systems/camera";
import { fitCameraToMap, tileToScreen } from "../systems/projection";
import type { PharosVilleAssetManifestEntry } from "../systems/asset-manifest";
import type { ShipMotionSample } from "../systems/motion";
import { areaLabelPlacementForArea } from "../systems/area-labels";
import type { LoadedPharosVilleAsset } from "./asset-manager";
import { dockDrawPoint, dockRenderScale } from "./geometry";
import { collectHitTargets, hitTest, type HitTarget } from "./hit-testing";

const TARGET_CLICK_POINTS = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;

const LIGHTHOUSE_ASSET_ENTRY: PharosVilleAssetManifestEntry = {
  anchor: [160, 306],
  beacon: [160, 50],
  category: "landmark",
  displayScale: 0.82,
  footprint: [88, 62],
  height: 320,
  hitbox: [48, 20, 224, 276],
  id: "landmark.lighthouse",
  layer: "landmarks",
  loadPriority: "critical",
  path: "landmarks/lighthouse-alexandria.png",
  width: 320,
};

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
    expect(targets.some((target) => target.kind === "building")).toBe(false);
    expect(targets.some((target) => target.kind === "area")).toBe(true);
    expect(targets.some((target) => target.detailId.startsWith("building."))).toBe(false);
  });

  it("selects the top-priority target under the pointer", () => {
    const ship = world.ships[0];
    expect(ship).toBeDefined();
    const point = tileToScreen(ship!.tile, camera);
    const match = hitTest(collectHitTargets({ camera, selectedDetailId: ship!.detailId, world }), point);

    expect(match?.detailId).toBe(ship?.detailId);
  });

  it("uses drawable depth when overlapping moving bodies compete", () => {
    const backShip = {
      ...world.ships[0]!,
      detailId: "ship.depth-back",
      id: "depth-back",
      label: "Depth Back",
      tile: { x: 20, y: 20 },
    };
    const frontShip = {
      ...world.ships[1]!,
      detailId: "ship.depth-front",
      id: "depth-front",
      label: "Depth Front",
      tile: { x: 20.18, y: 20.18 },
    };
    const targets = collectHitTargets({
      camera,
      hoveredDetailId: backShip.detailId,
      selectedDetailId: backShip.detailId,
      world: {
        ...world,
        areas: [],
        docks: [],
        graves: [],
        shipClusters: [],
        ships: [backShip, frontShip],
      },
    });
    const backTarget = targets.find((target) => target.detailId === backShip.detailId);
    const frontTarget = targets.find((target) => target.detailId === frontShip.detailId);
    expect(backTarget).toBeDefined();
    expect(frontTarget).toBeDefined();
    expect(frontTarget!.priority).toBeGreaterThan(backTarget!.priority);

    const point = {
      x: frontTarget!.rect.x + frontTarget!.rect.width / 2,
      y: frontTarget!.rect.y + frontTarget!.rect.height / 2,
    };
    expect(pointInRect(point, backTarget!.rect)).toBe(true);
    expect(hitTest(targets, point)?.detailId).toBe(frontShip.detailId);
  });

  it("aligns area hit targets to shared cartographic label placement", () => {
    const area = world.areas.find((entry) => entry.detailId === "area.dews.calm");
    expect(area).toBeDefined();
    const placement = areaLabelPlacementForArea(area!);
    const labelPoint = tileToScreen(placement.anchorTile, camera);
    const semanticPoint = tileToScreen(area!.tile, camera);
    const target = collectHitTargets({ camera, selectedDetailId: area!.detailId, world })
      .find((entry) => entry.detailId === area!.detailId);
    expect(target).toBeDefined();

    expect(target!.rect.x + target!.rect.width / 2).toBeCloseTo(labelPoint.x);
    expect(target!.rect.y + target!.rect.height / 2).toBeCloseTo(labelPoint.y);
    expect(labelPoint.x).not.toBeCloseTo(semanticPoint.x);
    expect(labelPoint.y).not.toBeCloseTo(semanticPoint.y);
  });

  it("keeps cartographic area labels selectable at their printed size", () => {
    const zoomedOutCamera = { ...camera, zoom: 0.48 };
    const area = world.areas.find((entry) => entry.detailId === "area.risk-water.ledger-mooring");
    expect(area).toBeDefined();
    const placement = areaLabelPlacementForArea(area!);
    const target = collectHitTargets({ camera: zoomedOutCamera, selectedDetailId: area!.detailId, world })
      .find((entry) => entry.detailId === area!.detailId);
    expect(target).toBeDefined();

    expect(target!.rect.width).toBeCloseTo(Math.max(52, placement.maxWidth * 0.72));
    expect(target!.rect.height).toBeCloseTo(Math.max(26, placement.hitboxHeight * 0.72));
  });

  it("keeps every water area label selectable from at least one visible point", () => {
    const targets = collectHitTargets({ camera, world });
    const areaTargets = targets.filter((entry) => entry.kind === "area");

    expect(areaTargets.length).toBeGreaterThan(0);
    for (const target of areaTargets) {
      expect(unoccludedTargetPoint(targets, target), `${target.detailId} should have a selectable label point`).not.toBeNull();
    }
  });

  it("keeps full area label rectangles clear of the compact lighthouse rectangle", () => {
    const viewports = [
      { width: 1280, height: 760 },
      { width: 1440, height: 1000 },
      { width: 2560, height: 1440 },
    ] as const;
    const assets = {
      get: (id: string): LoadedPharosVilleAsset | null => id === "landmark.lighthouse"
        ? { entry: LIGHTHOUSE_ASSET_ENTRY, image: {} as HTMLImageElement }
        : null,
    };

    for (const viewport of viewports) {
      const viewportCamera = defaultCamera({ height: viewport.height, width: viewport.width, map: world.map });
      const targets = collectHitTargets({ assets, camera: viewportCamera, world });
      const lighthouse = targets.find((target) => target.detailId === "lighthouse");
      expect(lighthouse).toBeDefined();
      const paddedLighthouse = padRect(lighthouse!.rect, 16 * viewportCamera.zoom);

      for (const target of targets.filter((entry) => entry.kind === "area")) {
        expect(rectsOverlap(target.rect, paddedLighthouse), `${viewport.width}x${viewport.height} ${target.detailId}`).toBe(false);
      }
    }
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

  it("keeps ships above the backgrounded Ethereum harbor hub hitbox", () => {
    const usdt = world.ships.find((entry) => entry.detailId === "ship.usdt-tether");
    const ethereumDock = world.docks.find((entry) => entry.detailId === "dock.ethereum");
    expect(usdt).toBeDefined();
    expect(ethereumDock).toBeDefined();

    const assets = {
      get: (id: string): LoadedPharosVilleAsset | null => {
        if (id === "dock.ethereum-harbor-hub") {
          return {
            entry: {
              anchor: [168, 186],
              category: "dock",
              displayScale: 1,
              footprint: [168, 72],
              height: 240,
              hitbox: [24, 18, 288, 176],
              id,
              layer: "docks",
              loadPriority: "critical",
              path: "docks/ethereum-harbor-hub.png",
              width: 336,
            },
            image: {} as HTMLImageElement,
          };
        }
        if (!id.startsWith("ship.")) return null;
        return {
          entry: {
            anchor: [40, 50],
            category: "ship",
            displayScale: 1,
            footprint: [20, 12],
            height: 64,
            hitbox: [8, 8, 64, 48],
            id,
            layer: "ships",
            loadPriority: "critical",
            path: `${id}.png`,
            width: 80,
          },
          image: {} as HTMLImageElement,
        };
      },
    };
    const targets = collectHitTargets({
      assets,
      camera,
      selectedDetailId: ethereumDock!.detailId,
      shipMotionSamples: new Map([[usdt!.id, motionSample(usdt!.id, ethereumDock!.tile)]]),
      world,
    });
    const ship = targets.find((target) => target.detailId === usdt!.detailId);
    const dock = targets.find((target) => target.detailId === ethereumDock!.detailId);
    expect(ship).toBeDefined();
    expect(dock).toBeDefined();

    const point = {
      x: ship!.rect.x + ship!.rect.width / 2,
      y: ship!.rect.y + ship!.rect.height / 2,
    };
    expect(pointInRect(point, dock!.rect)).toBe(true);
    expect(hitTest(targets, point)?.detailId).toBe(ship!.detailId);
  });

  it("aligns dock hitboxes to shared rendered harbor geometry", () => {
    const dock = world.docks.find((entry) => entry.detailId === "dock.ethereum");
    expect(dock).toBeDefined();
    const entry: PharosVilleAssetManifestEntry = {
      anchor: [48, 46],
      category: "dock",
      displayScale: 1,
      footprint: [42, 18],
      height: 64,
      hitbox: [8, 4, 80, 55],
      id: dock!.assetId,
      layer: "docks",
      loadPriority: "critical",
      path: "dock.png",
      width: 96,
    };
    const targets = collectHitTargets({
      assets: { get: (id) => id === dock!.assetId ? { entry, image: {} as HTMLImageElement } : null },
      camera,
      world,
    });
    const target = targets.find((candidate) => candidate.detailId === dock!.detailId);
    const drawPoint = dockDrawPoint(dock!, camera, world.map.width);
    const scale = camera.zoom * dockRenderScale(dock!.size) * entry.displayScale;

    expect(target).toBeDefined();
    expect(target!.rect.x).toBeCloseTo(drawPoint.x - entry.anchor[0] * scale + entry.hitbox[0] * scale);
    expect(target!.rect.y).toBeCloseTo(drawPoint.y - entry.anchor[1] * scale + entry.hitbox[1] * scale);
    expect(target!.rect.width).toBeCloseTo(entry.hitbox[2] * scale);
    expect(target!.rect.height).toBeCloseTo(entry.hitbox[3] * scale);
  });

  it("uses a compact tile-native lighthouse hitbox even when the generated sprite is available", () => {
    const lighthouse = world.lighthouse;
    const point = tileToScreen(lighthouse.tile, camera);
    const targets = collectHitTargets({
      assets: {
        get: (id) => id === "landmark.lighthouse"
          ? {
            entry: LIGHTHOUSE_ASSET_ENTRY,
            image: {} as HTMLImageElement,
          }
          : null,
      },
      camera,
      world,
    });

    const target = targets.find((entry) => entry.detailId === lighthouse.detailId);

    expect(target?.rect.x).toBeCloseTo(point.x - 80 * camera.zoom);
    expect(target?.rect.y).toBeCloseTo(point.y - 206 * camera.zoom);
    expect(target?.rect.width).toBeCloseTo(160 * camera.zoom);
    expect(target?.rect.height).toBeCloseTo(224 * camera.zoom);
  });
});

function motionSample(shipId: string, tile: { x: number; y: number }): ShipMotionSample {
  return {
    shipId,
    tile,
    state: "sailing",
    zone: "calm",
    currentDockId: null,
    heading: { x: 1, y: 0 },
    wakeIntensity: 0.4,
  };
}

function unoccludedTargetPoint(targets: readonly HitTarget[], target: HitTarget): { x: number; y: number } | null {
  for (const [x, y] of TARGET_CLICK_POINTS) {
    const point = {
      x: target.rect.x + target.rect.width * x,
      y: target.rect.y + target.rect.height * y,
    };
    if (hitTest(targets, point)?.detailId === target.detailId) return point;
  }
  return null;
}

function pointInRect(point: { x: number; y: number }, rect: HitTarget["rect"]) {
  return (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );
}

function rectsOverlap(first: HitTarget["rect"], second: HitTarget["rect"]) {
  return (
    first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y
  );
}

function padRect(rect: HitTarget["rect"], padding: number): HitTarget["rect"] {
  return {
    height: rect.height + padding * 2,
    width: rect.width + padding * 2,
    x: rect.x - padding,
    y: rect.y - padding,
  };
}
