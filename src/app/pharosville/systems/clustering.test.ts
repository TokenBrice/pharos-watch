import { describe, expect, it } from "vitest";
import { clusterLongTailShips } from "./clustering";
import { riskWaterAreaForPlacement } from "./risk-water-areas";
import { terrainKindAt, tileKindAt } from "./world-layout";
import type { ShipNode, ShipRiskPlacement } from "./world-types";

function makeShip(index: number, marketCapUsd: number, riskPlacement: ShipRiskPlacement = "safe-harbor"): ShipNode {
  const riskWaterArea = riskWaterAreaForPlacement(riskPlacement);
  return {
    id: `asset-${index}`,
    kind: "ship",
    label: `Asset ${index}`,
    symbol: `A${index}`,
    asset: {} as ShipNode["asset"],
    meta: {} as ShipNode["meta"],
    reportCard: null,
    logoSrc: null,
    tile: { x: 0, y: 0 },
    riskTile: { x: 0, y: 0 },
    chainPresence: [],
    dockVisits: [],
    dominantChainId: null,
    homeDockChainId: null,
    dockChainId: null,
    marketCapUsd,
    riskPlacement,
    riskZone: riskWaterArea.motionZone,
    riskWaterLabel: riskWaterArea.label,
    placementEvidence: { reason: "fixture", sourceFields: [], stale: false },
    visual: {
      hull: "treasury-galleon",
      shipClass: "cefi",
      classLabel: "CeFi",
      rigging: "issuer-rig",
      pennant: "emerald",
      overlay: "none",
      sizeTier: "major",
      sizeLabel: "Major",
      scale: 1,
    },
    change24hUsd: null,
    change24hPct: null,
    detailId: `ship.asset-${index}`,
  };
}

describe("clusterLongTailShips", () => {
  it("preserves inspectable member metadata for clustered ships", () => {
    const ships = [makeShip(1, 300), makeShip(2, 200), makeShip(3, 100)];

    const result = clusterLongTailShips(ships, 1);

    expect(result.visibleShips.map((ship) => ship.id)).toEqual(["asset-1"]);
    expect(result.clusters[0]?.shipIds).toEqual(["asset-2", "asset-3"]);
    expect(result.clusters[0]?.ships).toEqual([
      { id: "asset-2", label: "Asset 2", symbol: "A2", marketCapUsd: 200 },
      { id: "asset-3", label: "Asset 3", symbol: "A3", marketCapUsd: 100 },
    ]);
    const clusterTile = result.clusters[0]?.tile;
    expect(clusterTile).toBeDefined();
    expect(["water", "deep-water"]).toContain(tileKindAt(clusterTile?.x ?? -1, clusterTile?.y ?? -1));
    expect(result.clusters[0]?.riskWaterLabel).toBe("Calm Anchorage");
    expect(result.clusters[0]?.riskZone).toBe("calm");
    expect(terrainKindAt(clusterTile?.x ?? -1, clusterTile?.y ?? -1)).toBe("calm-water");
  });

  it("splits large long-tail groups into smaller water clusters", () => {
    const ships = Array.from({ length: 109 }, (_, index) => makeShip(index, 1_000 - index));

    const result = clusterLongTailShips(ships, 0);

    expect(result.clusters).toHaveLength(4);
    expect(Math.max(...result.clusters.map((cluster) => cluster.count))).toBeLessThanOrEqual(36);
    expect(result.clusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(109);
    expect(new Set(result.clusters.map((cluster) => `${cluster.tile.x}.${cluster.tile.y}`)).size).toBe(result.clusters.length);
    expect(result.clusters.every((cluster) => terrainKindAt(cluster.tile.x, cluster.tile.y) === "calm-water")).toBe(true);
  });

  it("keeps clusters inside their risk placement's semantic water", () => {
    const ships = [
      makeShip(1, 500, "storm-shelf"),
      makeShip(2, 400, "storm-shelf"),
      makeShip(3, 300, "outer-rough-water"),
      makeShip(4, 200, "outer-rough-water"),
      makeShip(5, 100, "ledger-mooring"),
      makeShip(6, 90, "ledger-mooring"),
      makeShip(7, 80, "breakwater-edge"),
      makeShip(8, 70, "safe-harbor"),
    ];

    const result = clusterLongTailShips(ships, 0);
    const terrainByPlacement = Object.fromEntries(
      result.clusters.map((cluster) => [cluster.riskPlacement, terrainKindAt(cluster.tile.x, cluster.tile.y)]),
    );
    const zoneByPlacement = Object.fromEntries(
      result.clusters.map((cluster) => [cluster.riskPlacement, cluster.riskZone]),
    );
    const labelByPlacement = Object.fromEntries(
      result.clusters.map((cluster) => [cluster.riskPlacement, cluster.riskWaterLabel]),
    );

    expect(terrainByPlacement["storm-shelf"]).toBe("storm-water");
    expect(terrainByPlacement["outer-rough-water"]).toBe("warning-water");
    expect(terrainByPlacement["ledger-mooring"]).toBe("ledger-water");
    expect(terrainByPlacement["breakwater-edge"]).toBe("watch-water");
    expect(terrainByPlacement["safe-harbor"]).toBe("calm-water");
    expect(zoneByPlacement["storm-shelf"]).toBe("danger");
    expect(zoneByPlacement["outer-rough-water"]).toBe("warning");
    expect(zoneByPlacement["ledger-mooring"]).toBe("ledger");
    expect(zoneByPlacement["breakwater-edge"]).toBe("watch");
    expect(zoneByPlacement["safe-harbor"]).toBe("calm");
    expect(labelByPlacement["storm-shelf"]).toBe("Danger Strait");
    expect(labelByPlacement["outer-rough-water"]).toBe("Warning Shoals");
    expect(labelByPlacement["ledger-mooring"]).toBe("Ledger Mooring");
    expect(labelByPlacement["breakwater-edge"]).toBe("Watch Breakwater");
    expect(labelByPlacement["safe-harbor"]).toBe("Calm Anchorage");
  });
});
