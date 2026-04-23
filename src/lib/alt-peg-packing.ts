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

function centerDistancePx(a: PackedCoin, b: PackedCoin): number {
  const dx = (a.x - b.x) * (FRAME_W / 100);
  const dy = (a.y - b.y) * (FRAME_H / 100);
  return Math.sqrt(dx * dx + dy * dy);
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
    const baseRadiusPx = Math.max(14, 0.6 * (prev.sizePx / 2 + coin.sizePx / 2));
    const angleDeg = INITIAL_ANGLE_DEG + (i - 1) * GOLDEN_ANGLE_DEG;
    const angleRad = (angleDeg * Math.PI) / 180;

    let radiusPx = baseRadiusPx;
    let candidate: PackedCoin | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const dxPercent = (radiusPx * Math.cos(angleRad)) / (FRAME_W / 100);
      const dyPercent = (radiusPx * Math.sin(angleRad)) / (FRAME_H / 100);
      candidate = { ...coin, x: anchor.x + dxPercent, y: anchor.y + dyPercent };
      const overlaps = placed.some((p) => {
        const minDist = ((p.sizePx + coin.sizePx) / 2) * 0.9;
        return centerDistancePx(p, candidate!) < minDist;
      });
      if (!overlaps) break;
      radiusPx += Math.max(4, coin.sizePx * 0.25);
    }
    placed.push(candidate!);
  }

  return placed;
}
