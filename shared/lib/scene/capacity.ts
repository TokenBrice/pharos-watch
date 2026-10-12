/**
 * Scene kit capacity contract. A scene validates its layout constants against the data and reports instead of drawing
 * badly: overlapping footprints or a face below its legibility floor fail a test (and data growth then needs a
 * re-tune). Scenes add their own issue kinds; the two generic checks live here.
 */
import { round1, SCENE_UNIT, type SceneCell } from "./projection";

export interface CapacityIssue<K extends string = string> {
  kind: K;
  message: string;
}

export interface CapacityReport<K extends string = string> {
  ok: boolean;
  issues: CapacityIssue<K>[];
  /** The scene's reference face size in CSS px, when it has one. */
  facePx: number | null;
}

/** Every pair of items whose footprints overlap by more than `eps` world units, in input order. */
export function footprintOverlaps<T>(items: readonly T[], cellOf: (item: T) => SceneCell, eps = 1e-6): [T, T][] {
  const out: [T, T][] = [];
  for (let a = 0; a < items.length; a++) {
    const A = cellOf(items[a]);
    for (let b = a + 1; b < items.length; b++) {
      const B = cellOf(items[b]);
      if (A.i0 < B.i1 - eps && B.i0 < A.i1 - eps && A.j0 < B.j1 - eps && B.j0 < A.j1 - eps) out.push([items[a], items[b]]);
    }
  }
  return out;
}

/**
 * CSS px of a face `faceUnits` world units wide when a viewBox `viewBoxWidth` SVG units wide fills a frame
 * `frameWidth` px wide (0.1-rounded). Compare against the scene's legibility floor.
 */
export function faceFloorPx(faceUnits: number, frameWidth: number, viewBoxWidth: number, unit = SCENE_UNIT): number {
  return round1((faceUnits * unit * frameWidth) / viewBoxWidth);
}
