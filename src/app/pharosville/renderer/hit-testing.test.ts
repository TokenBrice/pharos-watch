import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "../systems/pharosville-world";
import { fitCameraToMap, tileToScreen } from "../systems/projection";
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

    expect(target?.rect.x).toBeCloseTo(point.x - 30 * camera.zoom);
    expect(target?.rect.y).toBeCloseTo(point.y - 108 * camera.zoom);
    expect(target?.rect.width).toBeCloseTo(60 * camera.zoom);
    expect(target?.rect.height).toBeCloseTo(112 * camera.zoom);
  });
});
