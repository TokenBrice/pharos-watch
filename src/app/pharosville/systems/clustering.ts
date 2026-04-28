import type { ShipClusterNode, ShipNode, ShipRiskPlacement } from "./world-types";
import { nearestWaterTile, REGION_TILES } from "./world-layout";

export function clusterLongTailShips(ships: readonly ShipNode[], maxIndividualShips = 80): {
  visibleShips: ShipNode[];
  clusters: ShipClusterNode[];
} {
  const sorted = ships.toSorted((a, b) => b.marketCapUsd - a.marketCapUsd);
  const visibleShips = sorted.slice(0, maxIndividualShips);
  const longTail = sorted.slice(maxIndividualShips);
  const groups = new Map<ShipRiskPlacement, ShipNode[]>();

  for (const ship of longTail) {
    const group = groups.get(ship.riskPlacement) ?? [];
    group.push(ship);
    groups.set(ship.riskPlacement, group);
  }

  const clusters = [...groups.entries()].map(([riskPlacement, group]) => ({
    id: `cluster.${riskPlacement}`,
    kind: "ship-cluster" as const,
    label: `${group.length} ships`,
    tile: nearestWaterTile(REGION_TILES[riskPlacement]),
    riskPlacement,
    shipIds: group.map((ship) => ship.id),
    ships: group.map((ship) => ({
      id: ship.id,
      label: ship.label,
      symbol: ship.symbol,
      marketCapUsd: ship.marketCapUsd,
    })),
    count: group.length,
    totalUsd: group.reduce((sum, ship) => sum + ship.marketCapUsd, 0),
    detailId: `cluster.${riskPlacement}`,
  }));

  return { visibleShips, clusters };
}
