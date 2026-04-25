import { drawHarborIsland } from "../sprites/harbor-island-sprite";
import { worldToScreen } from "../systems/isometric";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import type { SceneHarbor } from "../systems/scene-data";

const TRIANGLE_TILES: { tileX: number; tileY: number }[] = [
  // Hero positions (around lighthouse at tile origin)
  { tileX: 22, tileY: 12 }, // NE
  { tileX: 8,  tileY: 24 }, // SW
  { tileX: 26, tileY: 22 }, // E
  // Mid-tier
  { tileX: 12, tileY: 8  },
  { tileX: 28, tileY: 8  },
  { tileX: 6,  tileY: 14 },
  { tileX: 30, tileY: 16 },
  { tileX: 18, tileY: 28 },
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
      _placements = harbors.slice(0, TRIANGLE_TILES.length).map((harbor, i) => {
        const tile = TRIANGLE_TILES[i];
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
