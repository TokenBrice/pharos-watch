/** A point a ribbon passes through: it enters at xIn and leaves at xOut with its top edge at `top`. */
export interface RibbonStation {
  xIn: number;
  xOut: number;
  top: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Filled ribbon of constant width through the stations, with horizontal cubic
 * links between consecutive stations. Drawn as a closed shape (not a stroked
 * line) so the rendered width is exact.
 */
export function ribbonPath(stations: readonly RibbonStation[], width: number): string {
  if (stations.length < 2) return "";
  const parts: string[] = [];
  const first = stations[0]!;
  parts.push(`M${round(first.xOut)},${round(first.top)}`);
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!, b = stations[i]!;
    const mid = (a.xOut + b.xIn) / 2;
    parts.push(`C${round(mid)},${round(a.top)} ${round(mid)},${round(b.top)} ${round(b.xIn)},${round(b.top)}`);
    if (i < stations.length - 1) parts.push(`L${round(b.xOut)},${round(b.top)}`);
  }
  const last = stations[stations.length - 1]!;
  parts.push(`L${round(last.xIn)},${round(last.top + width)}`);
  for (let i = stations.length - 1; i > 0; i--) {
    const a = stations[i - 1]!, b = stations[i]!;
    const mid = (a.xOut + b.xIn) / 2;
    if (i < stations.length - 1) parts.push(`L${round(b.xIn)},${round(b.top + width)}`);
    parts.push(`C${round(mid)},${round(b.top + width)} ${round(mid)},${round(a.top + width)} ${round(a.xOut)},${round(a.top + width)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/** Centre-line path for hairline (unknown-USD) links through the same stations. */
export function ribbonCenterline(stations: readonly RibbonStation[], width: number): string {
  if (stations.length < 2) return "";
  const half = width / 2;
  const first = stations[0]!;
  const parts = [`M${round(first.xOut)},${round(first.top + half)}`];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!, b = stations[i]!;
    const mid = (a.xOut + b.xIn) / 2;
    parts.push(`C${round(mid)},${round(a.top + half)} ${round(mid)},${round(b.top + half)} ${round(b.xIn)},${round(b.top + half)}`);
    if (i < stations.length - 1) parts.push(`L${round(b.xOut)},${round(b.top + half)}`);
  }
  return parts.join(" ");
}

/**
 * Linear width scale fixed from the full-graph largest known edge, so filters
 * and focus never rescale. `floorUsd` is the value below which the floor applies.
 */
export function createWidthScale(maxEdgeUsd: number, maxPx: number, floorPx: number) {
  const pxPerUsd = maxEdgeUsd > 0 && Number.isFinite(maxEdgeUsd) ? maxPx / maxEdgeUsd : 0;
  return {
    pxPerUsd,
    maxEdgeUsd: Math.max(0, maxEdgeUsd),
    floorPx,
    floorUsd: pxPerUsd > 0 ? floorPx / pxPerUsd : 0,
    width(usd: number | null): number {
      if (usd === null || !Number.isFinite(usd) || usd <= 0 || pxPerUsd === 0) return floorPx;
      return Math.max(floorPx, usd * pxPerUsd);
    },
  };
}
