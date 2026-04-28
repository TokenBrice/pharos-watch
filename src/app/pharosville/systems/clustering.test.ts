import { describe, expect, it } from "vitest";
import { clusterLongTailShips } from "./clustering";
import { tileKindAt } from "./world-layout";
import type { ShipNode } from "./world-types";

function makeShip(index: number, marketCapUsd: number): ShipNode {
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
    chainPresence: [],
    dockVisits: [],
    dominantChainId: null,
    homeDockChainId: null,
    dockChainId: null,
    marketCapUsd,
    riskPlacement: "safe-harbor",
    riskZone: "safe",
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
  });

  it("splits large long-tail groups into smaller water clusters", () => {
    const ships = Array.from({ length: 109 }, (_, index) => makeShip(index, 1_000 - index));

    const result = clusterLongTailShips(ships, 0);

    expect(result.clusters).toHaveLength(4);
    expect(Math.max(...result.clusters.map((cluster) => cluster.count))).toBeLessThanOrEqual(36);
    expect(result.clusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(109);
    expect(new Set(result.clusters.map((cluster) => `${cluster.tile.x}.${cluster.tile.y}`)).size).toBe(result.clusters.length);
    expect(result.clusters.every((cluster) => ["water", "deep-water"].includes(tileKindAt(cluster.tile.x, cluster.tile.y)))).toBe(true);
  });
});
