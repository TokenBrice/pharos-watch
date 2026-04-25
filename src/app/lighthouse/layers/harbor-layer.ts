import { drawHarborIsland } from "../sprites/harbor-island-sprite";
import { worldToScreen } from "../systems/isometric";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import type { SceneHarbor } from "../systems/scene-data";

// Harbours arrayed in a ring around the lighthouse anchor.
// Every entry has tileX+tileY ≤ -1 so screenY is negative (north of anchor).
// Spread is symmetric: tileX-tileY ∈ [-8, +8] so screenX ∈ [-256, +256].
const HARBOR_RING_TILES: { tileX: number; tileY: number }[] = [
  { tileX: -7, tileY: -1 }, // NW-far    screen(-192, -128)
  { tileX:  1, tileY: -7 }, // NE-far    screen(+256,  -96)
  { tileX: -6, tileY:  2 }, // W         screen(-256,  -64)
  { tileX:  2, tileY: -6 }, // E         screen(+256,  -64)
  { tileX: -3, tileY: -2 }, // NW-mid    screen( -32,  -80)
  { tileX: -2, tileY: -3 }, // NE-mid    screen( +32,  -80)
  { tileX: -4, tileY:  3 }, // SW-near   screen(-224,  -16)
  { tileX:  3, tileY: -4 }, // SE-near   screen(+224,  -16)
];

export interface HarborPlacement {
  harbor: SceneHarbor;
  worldX: number;
  worldY: number;
  /** Filled in by `draw()` after the first paint. */
  dockEndX: number;
  dockEndY: number;
  /** Filled in by `draw()` after the first paint. */
  lamps: { x: number; y: number; warm: boolean; phase: number }[];
}

export interface HarborLayerAPI extends DrawableLayer {
  /** Replace the placement set; returns a Map keyed by chain id for the orchestrator. */
  syncHarbors(
    harbors: SceneHarbor[],
    originX: number,
    originY: number,
  ): Map<string, HarborPlacement>;
  /** All current placements (for the scene-application effect to compute boat anchor positions). */
  placements(): readonly HarborPlacement[];
}

export function buildHarborLayer(): HarborLayerAPI {
  let _placements: HarborPlacement[] = [];

  return {
    syncHarbors(harbors, originX, originY) {
      const map = new Map<string, HarborPlacement>();
      _placements = harbors.slice(0, HARBOR_RING_TILES.length).map((harbor, i) => {
        const tile = HARBOR_RING_TILES[i];
        const screen = worldToScreen(tile);
        const placement: HarborPlacement = {
          harbor,
          worldX: originX + screen.x,
          worldY: originY + screen.y,
          dockEndX: 0,
          dockEndY: 0,
          lamps: [],
        };
        map.set(harbor.id, placement);
        return placement;
      });
      return map;
    },
    placements() {
      return _placements;
    },
    draw(ctx, _frame: FrameState) {
      // Painter's order — sort by world Y so south paints later
      const sorted = _placements.slice().sort((a, b) => a.worldY - b.worldY);
      for (const p of sorted) {
        const result = drawHarborIsland(
          ctx,
          Math.round(p.worldX),
          Math.round(p.worldY),
          p.harbor,
        );
        // Cache the dock terminus + lamps so the scene-application effect can read them
        p.dockEndX = result.dockEndX;
        p.dockEndY = result.dockEndY;
        p.lamps = result.lampPositions;
      }
    },
  };
}
