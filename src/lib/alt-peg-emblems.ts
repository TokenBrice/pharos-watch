/**
 * Percentage-based anchor positions for each fiat peg cluster, relative to
 * the world-map SVG's coordinate system (viewBox 0 0 900 460). Tuned by hand
 * against the rendered atlas so each cluster lands over the peg's main
 * territory. Consumed by alt-peg-hero.ts when packing coin emblems.
 */
export const PEG_ANCHORS: Record<string, { x: number; y: number }> = {
  EUR: { x: 52, y: 20 },
  CHF: { x: 51, y: 26 },
  GBP: { x: 49, y: 14 },
  RUB: { x: 66, y: 14 },
  TRY: { x: 58, y: 26 },
  JPY: { x: 83, y: 25 },
  IDR: { x: 81, y: 49 },
  SGD: { x: 76, y: 47 },
  CNH: { x: 77, y: 30 },
  PHP: { x: 82, y: 40 },
  BRL: { x: 36, y: 56 },
  CAD: { x: 28, y: 18 },
  MXN: { x: 24, y: 33 },
  ZAR: { x: 56, y: 65 },
  AUD: { x: 83, y: 63 },
};
