// src/app/lighthouse/systems/reduced-motion-freeze.ts
import type { SceneData } from "./scene-data";
import type { HarborPlacement } from "../layers/harbor-layer";

/**
 * Pick the placement of the harbour with the highest `totalUsd` that has been
 * painted at least once (so its `worldX`/`worldY` are real). Used by the
 * reduced-motion freeze: under reduced motion, the beam aims at the largest
 * harbour rather than rotating, conveying "the lighthouse is watching the
 * busiest port" while remaining still.
 */
export function pickLargestHarborPlacement(
  scene: SceneData,
  placements: ReadonlyMap<string, HarborPlacement>,
): HarborPlacement | null {
  let best: HarborPlacement | null = null;
  let bestUsd = -1;
  for (const harbor of scene.harbors) {
    const p = placements.get(harbor.id);
    if (!p) continue;
    if (harbor.totalUsd > bestUsd) {
      best = p;
      bestUsd = harbor.totalUsd;
    }
  }
  return best;
}

/** Aim a beam state at (toX, toY) from (fromX, fromY) by setting its `rotationRad`. */
export function aimBeamAt(
  beam: { rotationRad: number },
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  beam.rotationRad = Math.atan2(toY - fromY, toX - fromX);
}
