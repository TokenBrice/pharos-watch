export interface PackingInput {
  id: string;
  sizePx: number;
  marketCap: number;
}

export interface PackedCoin extends PackingInput {
  x: number;
  y: number;
}

const FRAME_W = 900;
const FRAME_H = 460;
const GOLDEN_ANGLE_DEG = 137.5;
const INITIAL_ANGLE_DEG = -90;
const DEFAULT_COLLISION_PADDING_PX = 5;

/**
 * Default cap on relaxation passes for {@link resolvePackedCoinOverlaps}. Each
 * pass is O(n²) over the cluster, so total work is O(iterations · n²). Current
 * callers pack small clusters (fiat-map and sky cohorts are well under ~30
 * coins), where the `if (!moved) break` early-exit converges in far fewer than
 * this many passes. Exported so UI tests can lower it for speed; if clusters
 * ever grow much larger, prefer a spatial grid over raising this ceiling.
 */
const DEFAULT_COLLISION_ITERATIONS = 90;

function centerDistancePx(a: PackedCoin, b: PackedCoin): number {
  const dx = (a.x - b.x) * (FRAME_W / 100);
  const dy = (a.y - b.y) * (FRAME_H / 100);
  return Math.sqrt(dx * dx + dy * dy);
}

function hashAngleRad(a: string, b: string): number {
  const key = `${a}:${b}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return ((hash % 360) * Math.PI) / 180;
}

function clampToFrame<T extends PackedCoin>(coin: T, frameWidthPx: number, frameHeightPx: number): T {
  const radiusXPct = (coin.sizePx / 2 + 2) / (frameWidthPx / 100);
  const radiusYPct = (coin.sizePx / 2 + 2) / (frameHeightPx / 100);
  return {
    ...coin,
    x: Math.min(100 - radiusXPct, Math.max(radiusXPct, coin.x)),
    y: Math.min(100 - radiusYPct, Math.max(radiusYPct, coin.y)),
  };
}

function defaultMobility(coin: PackedCoin): number {
  return Math.max(0.45, Math.min(1, 34 / Math.max(coin.sizePx, 1)));
}

export function arrangeClusterCoins(
  anchor: { x: number; y: number },
  coins: readonly PackingInput[],
): PackedCoin[] {
  const sorted = [...coins].sort((a, b) => b.sizePx - a.sizePx);
  const placed: PackedCoin[] = [];
  if (sorted.length === 0) return placed;

  placed.push({ ...sorted[0], x: anchor.x, y: anchor.y });

  for (let i = 1; i < sorted.length; i++) {
    const coin = sorted[i];
    const prev = sorted[i - 1];
    const baseRadiusPx = Math.max(16, 0.78 * (prev.sizePx / 2 + coin.sizePx / 2));
    const angleDeg = INITIAL_ANGLE_DEG + (i - 1) * GOLDEN_ANGLE_DEG;
    const angleRad = (angleDeg * Math.PI) / 180;

    let radiusPx = baseRadiusPx;
    let candidate: PackedCoin | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const dxPercent = (radiusPx * Math.cos(angleRad)) / (FRAME_W / 100);
      const dyPercent = (radiusPx * Math.sin(angleRad)) / (FRAME_H / 100);
      candidate = { ...coin, x: anchor.x + dxPercent, y: anchor.y + dyPercent };
      const overlaps = placed.some((p) => {
        const minDist = ((p.sizePx + coin.sizePx) / 2) * 1.04;
        return centerDistancePx(p, candidate!) < minDist;
      });
      if (!overlaps) break;
      radiusPx += Math.max(4, coin.sizePx * 0.25);
    }
    placed.push(candidate!);
  }

  return placed;
}

export function resolvePackedCoinOverlaps<T extends PackedCoin>(
  coins: readonly T[],
  {
    frameWidthPx = FRAME_W,
    frameHeightPx = FRAME_H,
    paddingPx = DEFAULT_COLLISION_PADDING_PX,
    iterations = DEFAULT_COLLISION_ITERATIONS,
    getMobility = defaultMobility,
  }: {
    frameWidthPx?: number;
    frameHeightPx?: number;
    paddingPx?: number;
    iterations?: number;
    getMobility?: (coin: T) => number;
  } = {},
): T[] {
  let placed = coins.map((coin) => ({ ...coin })) as T[];
  if (placed.length < 2) return placed;

  for (let iteration = 0; iteration < iterations; iteration++) {
    let moved = false;

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        let dxPx = (b.x - a.x) * (frameWidthPx / 100);
        let dyPx = (b.y - a.y) * (frameHeightPx / 100);
        let distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);

        if (distPx === 0) {
          const angle = hashAngleRad(a.id, b.id);
          dxPx = Math.cos(angle);
          dyPx = Math.sin(angle);
          distPx = 1;
        }

        const minDistPx = (a.sizePx + b.sizePx) / 2 + paddingPx;
        if (distPx >= minDistPx) continue;

        const overlapPx = minDistPx - distPx;
        const nx = dxPx / distPx;
        const ny = dyPx / distPx;
        const aMobility = Math.max(0.05, getMobility(a));
        const bMobility = Math.max(0.05, getMobility(b));
        const totalMobility = aMobility + bMobility;
        const aMovePx = (overlapPx * aMobility) / totalMobility;
        const bMovePx = (overlapPx * bMobility) / totalMobility;

        placed[i] = {
          ...a,
          x: a.x - (nx * aMovePx) / (frameWidthPx / 100),
          y: a.y - (ny * aMovePx) / (frameHeightPx / 100),
        };
        placed[j] = {
          ...b,
          x: b.x + (nx * bMovePx) / (frameWidthPx / 100),
          y: b.y + (ny * bMovePx) / (frameHeightPx / 100),
        };
        moved = true;
      }
    }

    placed = placed.map((coin) => clampToFrame(coin, frameWidthPx, frameHeightPx));
    if (!moved) break;
  }

  return placed;
}
