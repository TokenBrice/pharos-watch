export interface Pt { x: number; y: number; }

/**
 * Generate a deterministic 4-point patrol path: home -> midpoint detour ->
 * near-beacon -> home. The detour magnitudes are seeded by `seed` (typically
 * a stablecoin id) so each ship has its own characteristic route.
 *
 * Phase 4.4 interpolates a position along this path each frame.
 */
export function generatePatrolPath(home: Pt, beacon: Pt, seed: string): Pt[] {
  const rng = stringRng(seed);
  const midX = (home.x + beacon.x) / 2;
  const midY = (home.y + beacon.y) / 2;
  const detourX = (rng() - 0.5) * 80;
  const detourY = (rng() - 0.5) * 40;
  return [
    home,
    { x: midX + detourX, y: midY + detourY },
    { x: beacon.x + (rng() - 0.5) * 30, y: beacon.y + (rng() - 0.5) * 20 },
    home,
  ];
}

function stringRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 13), 2654435761);
    h ^= h >>> 16;
    return ((h >>> 0) / 0xffffffff);
  };
}
