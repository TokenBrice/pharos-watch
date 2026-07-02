export interface HorizonPoint {
  x: number;
  y: number;
}

export interface HorizonPackedDots {
  pts: HorizonPoint[];
  /** Field radius (cluster extent + breathing room). */
  fieldR: number;
}

export interface HorizonPhaseLayout extends HorizonPackedDots {
  /** Coins beyond the visible dots, summarised by a "+N" pill (0 when all fit). */
  hidden: number;
}

export const HORIZON_CONSTELLATION_LAYOUT = {
  dot: 22,
  dotSpacing: 30,
  pad: 12,
  logoInner: 18,
  minFieldRadius: 58,
  countFieldScale: 7,
  maxFieldRadius: 92,
  maxDots: 12,
  overflowRing: 8,
  narrowLaneDots: 8,
} as const;

// Pack dots into a circular cluster centered on (0, 0). Up to 6 form a single
// polygon ring; 7+ get a center dot wrapped by concentric rings.
function packHorizonDots(count: number): HorizonPackedDots {
  const { dot, dotSpacing, pad } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= 0) return { pts: [], fieldR: dotSpacing * 0.7 };
  if (count === 1) return { pts: [{ x: 0, y: 0 }], fieldR: dot / 2 + pad };
  if (count <= 6) {
    const r = dotSpacing / (2 * Math.sin(Math.PI / count));
    const pts = Array.from({ length: count }, (_, k) => {
      const a = (k / count) * 2 * Math.PI - Math.PI / 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    return { pts, fieldR: r + dot / 2 + pad };
  }

  const pts = [{ x: 0, y: 0 }];
  let rem = count - 1;
  let ring = 1;
  let lastR = 0;
  while (rem > 0) {
    const r = ring * dotSpacing;
    const cap = Math.max(1, Math.round((2 * Math.PI * r) / dotSpacing));
    const cnt = Math.min(cap, rem);
    for (let k = 0; k < cnt; k++) {
      // Offset each ring's start so outer dots nest between inner ones.
      const a = (k / cnt) * 2 * Math.PI - Math.PI / 2 + ring * 0.4;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    lastR = r;
    rem -= cnt;
    ring++;
  }
  return { pts, fieldR: lastR + dot / 2 + pad };
}

export function layoutHorizonPhase(count: number): HorizonPhaseLayout {
  const { dot, dotSpacing, maxDots, overflowRing, pad } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= maxDots) {
    const { pts, fieldR } = packHorizonDots(count);
    return { pts, fieldR, hidden: 0 };
  }

  const r = dotSpacing / (2 * Math.sin(Math.PI / overflowRing));
  const pts = Array.from({ length: overflowRing }, (_, k) => {
    const a = (k / overflowRing) * 2 * Math.PI - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  return { pts, fieldR: r + dot / 2 + pad, hidden: count - overflowRing };
}

function phaseFieldRadius(count: number, layout: HorizonPhaseLayout): number {
  const { countFieldScale, maxFieldRadius, minFieldRadius } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= 0) return Math.max(layout.fieldR, minFieldRadius);
  const countRadius = minFieldRadius + Math.sqrt(count) * countFieldScale;
  return Math.min(maxFieldRadius, Math.max(layout.fieldR, countRadius));
}

export function phaseRingSize(count: number, layout: HorizonPhaseLayout): number {
  return phaseFieldRadius(count, layout) * 2;
}
