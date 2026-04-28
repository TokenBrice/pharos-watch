import type { PharosVilleWorld, ShipNode } from "./world-types";

export const MAX_ANIMATED_WORLD_ENTITIES = 80;

export interface PharosVilleMotionPlan {
  animatedShipIds: ReadonlySet<string>;
  lighthouseSweepRadiansPerSecond: number;
  moverShipIds: ReadonlySet<string>;
  shipPhases: ReadonlyMap<string, number>;
}

const BAND_SWEEP_SPEED: Record<string, number> = {
  critical: 0.18,
  danger: 0.28,
  degraded: 0.38,
  healthy: 0.52,
  stable: 0.48,
  warning: 0.32,
};

export function buildMotionPlan(world: PharosVilleWorld, selectedDetailId: string | null): PharosVilleMotionPlan {
  const selectedShip = selectedDetailId
    ? world.ships.find((ship) => ship.detailId === selectedDetailId)
    : null;
  const topShips = world.ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, 48);
  const moverShips = world.ships
    .filter(hasRecentMove)
    .toSorted((a, b) => Math.abs(b.change24hUsd ?? 0) - Math.abs(a.change24hUsd ?? 0))
    .slice(0, 16);
  const animatedShipIds = new Set<string>();
  if (selectedShip) animatedShipIds.add(selectedShip.id);
  for (const ship of topShips) {
    if (animatedShipIds.size >= MAX_ANIMATED_WORLD_ENTITIES) break;
    animatedShipIds.add(ship.id);
  }
  for (const ship of moverShips) {
    if (animatedShipIds.size >= MAX_ANIMATED_WORLD_ENTITIES) break;
    animatedShipIds.add(ship.id);
  }

  return {
    animatedShipIds,
    lighthouseSweepRadiansPerSecond: lighthouseSweepSpeed(world.lighthouse.psiBand, world.lighthouse.score),
    moverShipIds: new Set(moverShips.map((ship) => ship.id)),
    shipPhases: new Map(world.ships.map((ship) => [ship.id, stableMotionPhase(ship.id)])),
  };
}

export function lighthouseSweepSpeed(band: string | null, score: number | null) {
  const base = band ? BAND_SWEEP_SPEED[band.toLowerCase()] ?? 0.34 : 0.22;
  if (score == null) return base;
  return base * (0.85 + Math.max(0, Math.min(100, score)) / 500);
}

export function stableMotionPhase(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return (hash % 628) / 100;
}

function hasRecentMove(ship: ShipNode) {
  const absolute = Math.abs(ship.change24hUsd ?? 0);
  const percentage = Math.abs(ship.change24hPct ?? 0);
  return absolute >= 1_000_000 || percentage >= 0.01;
}
