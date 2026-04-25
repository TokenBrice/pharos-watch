import { HARBOR_PALETTE } from "../systems/palette";
import type { SceneHarbor } from "../systems/scene-data";

export interface HarborIslandResult {
  /** Lamp positions in canvas coordinates (warehouse + dock-end). */
  lampPositions: { x: number; y: number; warm: boolean; phase: number }[];
  /** Canvas x of the dock terminus where boats anchor. */
  dockEndX: number;
  dockEndY: number;
}

export function drawHarborIsland(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  harbor: SceneHarbor,
): HarborIslandResult {
  // Footprint: log-scaled by total supply
  const footprintW = 80 + Math.min(80, Math.log10(Math.max(1, harbor.totalUsd / 1e6)) * 18);
  const footprintH = footprintW * 0.6;
  const halfW = footprintW / 2;

  // Resilience tier dictates dock material
  const dockColor =
    harbor.resilienceTier === 1 ? HARBOR_PALETTE.stone_pale
    : harbor.resilienceTier === 3 ? HARBOR_PALETTE.timber_dark
    : HARBOR_PALETTE.timber_mid;

  // Island top — diamond
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  poly(ctx, [
    ax - halfW, ay,
    ax,         ay - footprintH / 2,
    ax + halfW, ay,
    ax,         ay + footprintH / 2,
  ]);

  // Left face
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  poly(ctx, [
    ax - halfW, ay,
    ax,         ay + footprintH / 2,
    ax,         ay + footprintH / 2 + 6,
    ax - halfW, ay + 6,
  ]);

  // Right face
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  poly(ctx, [
    ax,         ay + footprintH / 2,
    ax + halfW, ay,
    ax + halfW, ay + 6,
    ax,         ay + footprintH / 2 + 6,
  ]);

  // Dock pier
  ctx.fillStyle = dockColor;
  ctx.fillRect(ax - halfW * 0.6, ay + footprintH / 2 + 6, halfW * 1.2, 8);

  // Warehouses — N = ceil(stablecoinCount / 3), capped at 4
  const lampPositions: HarborIslandResult["lampPositions"] = [];
  const wHouseCount = Math.min(4, Math.max(1, Math.ceil(harbor.stablecoinCount / 3)));
  for (let i = 0; i < wHouseCount; i++) {
    const wx = ax - halfW * 0.7 + i * 16;
    const wy = ay - footprintH * 0.1;
    // Body
    ctx.fillStyle = HARBOR_PALETTE.timber_dark;
    ctx.fillRect(wx, wy - 12, 12, 12);
    // Roof
    ctx.fillStyle = HARBOR_PALETTE.stone_dark;
    poly(ctx, [wx - 1, wy - 12, wx + 6, wy - 16, wx + 13, wy - 12]);
    // Lit window on alternating warehouses
    if (i % 2 === 0) {
      ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
      ctx.fillRect(wx + 4, wy - 8, 3, 2);
    }
    lampPositions.push({ x: wx + 6, y: wy - 2, warm: true, phase: i * 0.7 });
  }

  const dockEndX = ax + halfW * 0.5;
  const dockEndY = ay + footprintH / 2 + 14;
  // Lantern at dock terminus (where boats moor)
  lampPositions.push({ x: dockEndX, y: dockEndY, warm: true, phase: 0.3 });

  return { lampPositions, dockEndX, dockEndY };
}

function poly(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}
