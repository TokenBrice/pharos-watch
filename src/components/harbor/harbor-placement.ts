/**
 * Harbor free-water placement for the record card and the hover tag: the open sea beside the fleet is the only room
 * that covers nothing, so candidates are scored by how much berth hull and quay label they cover, then by distance to
 * the anchor. Pure; all inputs and outputs are in one coordinate space (viewport px for the card, frame px for the tag).
 */
import type { SceneRect } from "@shared/lib/scene/placement";
import type { ScenePoint } from "@shared/lib/scene/projection";

const STEP = 24;
const SAMPLES = 7;
/** A covered label sample costs more than a covered hull sample: text is what the card must never hide. */
const LABEL_WEIGHT = 3;

function inPolygon(x: number, y: number, poly: readonly ScenePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Best spot for a `size` box inside `area`, minimising covered hull/label samples, then distance to `anchor`
 * (`distanceWeight` cost per px). `blocked` rects are hard exclusions (e.g. a fixed corner control).
 */
export function placeOnFreeWater(input: {
  area: SceneRect;
  size: { width: number; height: number };
  anchor: ScenePoint;
  hulls: readonly (readonly ScenePoint[])[];
  labels: readonly SceneRect[];
  blocked?: readonly SceneRect[];
  distanceWeight: number;
}): { x: number; y: number } {
  const { area, size, anchor, labels, blocked = [], distanceWeight } = input;
  const hulls = input.hulls.map((poly) => {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    return { poly, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const xMax = Math.max(area.left, area.right - size.width);
  const yMax = Math.max(area.top, area.bottom - size.height);
  const steps = (from: number, to: number) => [...Array.from({ length: Math.floor((to - from) / STEP) + 1 }, (_, k) => from + k * STEP), to];
  let best = { x: area.left, y: area.top, cost: Infinity };
  for (const y of steps(area.top, yMax)) {
    for (const x of steps(area.left, xMax)) {
      const rect = { left: x, top: y, right: x + size.width, bottom: y + size.height };
      if (blocked.some((b) => rect.left < b.right && rect.right > b.left && rect.top < b.bottom && rect.bottom > b.top)) continue;
      let covered = 0;
      for (let a = 0; a < SAMPLES; a++) {
        const sy = y + ((a + 0.5) / SAMPLES) * size.height;
        for (let b = 0; b < SAMPLES; b++) {
          const sx = x + ((b + 0.5) / SAMPLES) * size.width;
          if (labels.some((r) => sx >= r.left - 4 && sx <= r.right + 4 && sy >= r.top - 4 && sy <= r.bottom + 4)) covered += LABEL_WEIGHT;
          else if (hulls.some((h) => sx >= h.x0 && sx <= h.x1 && sy >= h.y0 && sy <= h.y1 && inPolygon(sx, sy, h.poly))) covered += 1;
        }
      }
      const dx = Math.max(rect.left - anchor[0], 0, anchor[0] - rect.right);
      const dy = Math.max(rect.top - anchor[1], 0, anchor[1] - rect.bottom);
      const cost = covered + Math.hypot(dx, dy) * distanceWeight;
      if (cost < best.cost) best = { x, y, cost };
    }
  }
  return { x: best.x, y: best.y };
}
