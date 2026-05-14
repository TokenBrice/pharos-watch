/**
 * Percentage-based anchor positions for each fiat peg cluster, relative to
 * the world-map SVG's coordinate system (viewBox 0 0 900 460). Tuned by hand
 * against the rendered atlas so each cluster lands over the peg's main
 * territory. Consumed by alt-peg-hero.ts when packing coin emblems.
 */
export const PEG_ANCHORS: Record<string, { x: number; y: number }> = {
  EUR: { x: 53, y: 28 },
  CHF: { x: 50, y: 28 },
  GBP: { x: 49, y: 23 },
  RUB: { x: 72, y: 19 },
  TRY: { x: 59, y: 33 },
  JPY: { x: 86, y: 34 },
  KRW: { x: 83, y: 34 },
  IDR: { x: 83, y: 59 },
  MYR: { x: 81, y: 55 },
  SGD: { x: 79, y: 56 },
  CNH: { x: 77, y: 34 },
  PHP: { x: 84, y: 50 },
  KGS: { x: 69, y: 31 },
  BRL: { x: 35, y: 64 },
  ARS: { x: 33, y: 80 },
  NGN: { x: 52, y: 51 },
  XOF: { x: 48, y: 51 },
  CAD: { x: 28, y: 20 },
  MXN: { x: 22, y: 42 },
  ZAR: { x: 57, y: 76 },
  AUD: { x: 86, y: 74 },
};
