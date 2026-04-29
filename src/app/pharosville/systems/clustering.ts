import type { ShipClusterNode, ShipNode, ShipRiskPlacement } from "./world-types";
import { clampMapTile, nearestAvailableWaterTile, REGION_TILES } from "./world-layout";
import { nearestAvailableRiskPlacementWaterTile } from "./risk-water-placement";
import { riskWaterAreaForPlacement } from "./risk-water-areas";
import { stableUnit } from "./stable-random";

const MAX_SHIPS_PER_CLUSTER = 36;
const DEFAULT_INDIVIDUAL_SHIP_BUDGET = 128;

export function clusterLongTailShips(ships: readonly ShipNode[], maxIndividualShips = DEFAULT_INDIVIDUAL_SHIP_BUDGET): {
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

  const occupied = new Set<string>();
  const clusters = [...groups.entries()].flatMap(([riskPlacement, group]) => {
    const chunks = chunkShips(group, MAX_SHIPS_PER_CLUSTER);
    return chunks.map((chunk, index) => {
      const suffix = chunks.length === 1 ? "" : `.${index + 1}`;
      const riskWaterArea = riskWaterAreaForPlacement(riskPlacement);
      return {
        id: `cluster.${riskPlacement}${suffix}`,
        kind: "ship-cluster" as const,
        label: `${chunk.length} ships`,
        tile: clusterTile(riskPlacement, index, chunks.length, occupied),
        riskPlacement,
        riskZone: riskWaterArea.motionZone,
        riskWaterLabel: riskWaterArea.label,
        shipIds: chunk.map((ship) => ship.id),
        ships: chunk.map((ship) => ({
          id: ship.id,
          label: ship.label,
          symbol: ship.symbol,
          marketCapUsd: ship.marketCapUsd,
        })),
        count: chunk.length,
        totalUsd: chunk.reduce((sum, ship) => sum + ship.marketCapUsd, 0),
        detailId: `cluster.${riskPlacement}${suffix}`,
      } satisfies ShipClusterNode;
    });
  });

  return { visibleShips, clusters };
}

function chunkShips(ships: ShipNode[], size: number): ShipNode[][] {
  const chunks: ShipNode[][] = [];
  for (let index = 0; index < ships.length; index += size) {
    chunks.push(ships.slice(index, index + size));
  }
  return chunks;
}

function clusterTile(
  riskPlacement: ShipRiskPlacement,
  index: number,
  count: number,
  occupied: Set<string>,
): { x: number; y: number } {
  const base = REGION_TILES[riskPlacement];
  const angle = stableUnit(`cluster.${riskPlacement}.${index}.angle`) * Math.PI * 2
    + (count > 1 ? (Math.PI * 2 * index) / count : 0);
  const radius = count > 1 ? 4.5 + index * 1.4 : 1.5;
  const candidate = clampMapTile({
    x: Math.round(base.x + Math.cos(angle) * radius * 1.35),
    y: Math.round(base.y + Math.sin(angle) * radius * 0.92),
  });
  const tile = nearestAvailableRiskPlacementWaterTile(candidate, riskPlacement, occupied, 18)
    ?? nearestAvailableWaterTile(candidate, occupied, 18);
  occupied.add(`${tile.x}.${tile.y}`);
  return tile;
}
