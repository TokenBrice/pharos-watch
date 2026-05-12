import type { ChainHarborEntry } from "./harbor-map";

export type ShipGeometry = {
  hullTop: number;
  hullBottom: number;
  hullMidY: number;
  keelY: number;
  deckLeft: number;
  deckRight: number;
  sternInset: number;
  bowRise: number;
  railY: number;
  mainMastX: number;
  foreMastX: number;
  aftMastX: number;
  mastTopY: number;
  foreTopY: number;
  aftTopY: number;
  rigScale: number;
  hullDepth: number;
  hullW: number;
  flagWidth: number;
  logoSize: number;
  sailSealY: number;
};

export function shipDimensions(
  entry: ChainHarborEntry,
  x: number,
  hullW: number,
  laneY: number,
  supplyScale: number,
): ShipGeometry {
  const rigScale = 0.62 + supplyScale * 0.7;
  const hullDepth = 16 + supplyScale * 12;
  const hullTop = laneY + 12 - supplyScale * 7;
  const hullBottom = hullTop + hullDepth;
  const deckLeft = x;
  const deckRight = x + hullW;
  const sternInset = Math.min(13, Math.max(7, hullW * 0.1));
  const bowRise = Math.min(22, Math.max(12, hullW * 0.18));
  const hullMidY = hullTop + hullDepth * 0.55;
  const keelY = hullBottom - 2;
  const mainMastX = deckLeft + hullW * 0.55;
  const foreMastX = deckLeft + hullW * 0.27;
  const aftMastX = deckLeft + hullW * 0.76;
  const mastTopY = hullTop - 78 * rigScale;
  const foreTopY = hullTop - 56 * rigScale;
  const aftTopY = hullTop - 49 * rigScale;
  const railY = hullTop - 3;
  const flagWidth = Math.max(14, Math.min(48, (entry.dominantSharePct / 100) * 48)) * (0.86 + supplyScale * 0.24);
  const logoSize = 13 + supplyScale * 7;
  const sailSealY = hullTop - 18 - supplyScale * 6;
  return {
    hullTop,
    hullBottom,
    hullMidY,
    keelY,
    deckLeft,
    deckRight,
    sternInset,
    bowRise,
    railY,
    mainMastX,
    foreMastX,
    aftMastX,
    mastTopY,
    foreTopY,
    aftTopY,
    rigScale,
    hullDepth,
    hullW,
    flagWidth,
    logoSize,
    sailSealY,
  };
}
